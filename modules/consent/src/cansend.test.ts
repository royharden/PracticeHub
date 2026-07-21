import { describe, expect, it } from 'vitest';

import {
  applyKeyword,
  canSend,
  consentForDisclosure,
  type CanSendInput,
  type ConsentAuditInput,
} from './cansend.js';
import {
  canonicalConsentScopeKey,
  consentChannels,
  consentPurposes,
  consentStateValues,
  type ConsentStateValue,
  type ConsentStateRow,
} from './consent.js';
import type { CommunicationOverlay } from './overlays.js';

const tenant = 'northwind-synthetic';

function commState(
  currentState: ConsentStateValue,
  overrides: Partial<ConsentStateRow> = {},
): ConsentStateRow {
  const channel = overrides.channel ?? 'sms';
  const purpose = overrides.purpose ?? 'treatment';
  return {
    tenantId: tenant,
    personRef: 'np-fx',
    scopeKey: canonicalConsentScopeKey({ type: 'communication', channel, purpose }),
    scopeType: 'communication',
    channel,
    purpose,
    currentState,
    effectiveAt: '2026-02-01T00:00:00Z',
    lastEventId: 'ce-1',
    quietHoursTz: 'UTC',
    jurisdiction: 'NV',
    synthetic: true,
    ...overrides,
  };
}

function input(overrides: Partial<CanSendInput> = {}): CanSendInput {
  return {
    tenantId: tenant,
    personRef: 'np-fx',
    channel: 'sms',
    purpose: 'treatment',
    state: commState('opted_in'),
    urgency: 'routine',
    asOf: '2026-03-15T00:00:00Z',
    actorRef: 'synthetic-staff:fixture',
    occurredAt: '2026-03-15T09:00:00Z',
    ...overrides,
  };
}

describe('canSend truth table (state x urgency)', () => {
  const expectations: Record<ConsentStateValue, { routine: boolean; urgent: boolean }> = {
    opted_in: { routine: true, urgent: true },
    opted_out: { routine: false, urgent: false },
    blocked: { routine: false, urgent: false },
    expired: { routine: false, urgent: false },
    pending: { routine: false, urgent: true },
  };

  for (const state of consentStateValues) {
    for (const urgency of ['routine', 'urgent'] as const) {
      it(`${state} / ${urgency} -> ${expectations[state][urgency] ? 'allow' : 'deny'}`, () => {
        const decision = canSend(input({ state: commState(state), urgency }));
        expect(decision.allow).toBe(expectations[state][urgency]);
      });
    }
  }

  it('an absent projection ALWAYS fails closed across every channel and purpose (RSK-02)', () => {
    for (const channel of consentChannels) {
      for (const purpose of consentPurposes) {
        for (const urgency of ['routine', 'urgent'] as const) {
          const decision = canSend(input({ channel, purpose, state: null, urgency }));
          expect(decision.allow, `${channel}/${purpose}/${urgency}`).toBe(false);
          expect(decision.reason).toBe('no-consent-on-record');
        }
      }
    }
  });

  it('the deny reasons are specific to the failing step', () => {
    expect(canSend(input({ state: commState('opted_out') })).reason).toBe('opted-out');
    expect(canSend(input({ state: commState('blocked') })).reason).toBe('blocked');
    expect(canSend(input({ state: commState('pending') })).reason).toBe('consent-pending');
  });
});

describe('canSend expiry (R6-SR-041 auto-block)', () => {
  it('treats a lapsed expires_at as expired at send-time, even while opted_in', () => {
    const state = commState('opted_in', { expiresAt: '2026-01-01T00:00:00Z' });
    expect(canSend(input({ state, asOf: '2026-03-15T00:00:00Z' })).reason).toBe('consent-expired');
    // Still live before the expiry date.
    expect(canSend(input({ state, asOf: '2025-12-01T00:00:00Z' })).allow).toBe(true);
  });
});

describe('canSend ai_voice distinct channel (R6-REQ-074)', () => {
  it('a voice opt-in never satisfies an ai_voice send (absent ai_voice state fails closed)', () => {
    // The caller resolves the ai_voice scope; a voice-only opt-in leaves it null.
    const decision = canSend(input({ channel: 'ai_voice', state: null }));
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('no-consent-on-record');
  });
});

describe('canSend overlay / quiet-hours / carrier branches', () => {
  const chdOverlay: CommunicationOverlay = {
    chdOptInRequired: true,
    chdSaleSeparateAuth: false,
    aiDisclosureRequired: false,
    counselReviewPending: true,
    defaultsApplied: false,
    obligations: ['chd-opt-in'],
  };

  it('refuses a marketing send when CHD opt-in is required and the opt-in is not affirmative', () => {
    const decision = canSend(
      input({
        purpose: 'marketing',
        state: commState('opted_in', { purpose: 'marketing' }),
        overlay: chdOverlay,
        governingSourceAffirmative: false,
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('chd-opt-in-required');
    expect(decision.overlayObligations).toEqual(['chd-opt-in']);
    expect(decision.counselReviewPending).toBe(true);
  });

  it('allows the same marketing send when the opt-in is affirmative', () => {
    const decision = canSend(
      input({
        purpose: 'marketing',
        state: commState('opted_in', { purpose: 'marketing' }),
        overlay: chdOverlay,
        governingSourceAffirmative: true,
      }),
    );
    expect(decision.allow).toBe(true);
  });

  it('defers outside quiet hours unless urgent treatment', () => {
    expect(canSend(input({ localHour: 22 })).reason).toBe('quiet-hours-deferred');
    expect(canSend(input({ localHour: 7 })).reason).toBe('quiet-hours-deferred');
    expect(canSend(input({ localHour: 12 })).allow).toBe(true);
    // Urgent treatment overrides quiet hours.
    expect(canSend(input({ localHour: 22, urgency: 'urgent', purpose: 'treatment' })).allow).toBe(
      true,
    );
  });

  it('honors carrier STOP as defence in depth for sms', () => {
    expect(canSend(input({ channel: 'sms', carrierStopSet: true })).reason).toBe('carrier-stop');
    // A non-sms channel is unaffected by the carrier flag.
    expect(canSend(input({ channel: 'email', carrierStopSet: true })).allow).toBe(true);
  });
});

describe('canSend audit input (R6-REQ-024)', () => {
  it('every decision — allow AND deny — is born with a consent-event audit input', () => {
    const allow = canSend(input());
    const deny = canSend(input({ state: commState('opted_out') }));
    for (const decision of [allow, deny]) {
      const audit: ConsentAuditInput = decision.auditInput;
      expect(audit.stream).toBe('consent-event');
      expect(audit.correlationRef).toBe('consent:np-fx:sms:treatment');
      expect(audit.decision).toBe(decision.allow ? 'allow' : 'deny');
      expect(audit.detail['reason']).toBe(decision.reason);
    }
    expect(allow.auditInput.action).toBe('send-permitted');
    expect(deny.auditInput.action).toBe('send-refused');
  });
});

describe('consentForDisclosure (ConsentPort, fail-closed)', () => {
  function discState(
    currentState: ConsentStateValue,
    overrides: Partial<ConsentStateRow> = {},
  ): ConsentStateRow {
    return {
      tenantId: tenant,
      personRef: 'np-fx',
      scopeKey: 'disclosure|purpose=treatment|recipient=synthetic-recipient:r-1|record=general',
      scopeType: 'disclosure',
      purpose: 'treatment',
      recipientRef: 'synthetic-recipient:r-1',
      recordType: 'general',
      currentState,
      effectiveAt: '2026-02-01T00:00:00Z',
      lastEventId: 'ce-1',
      quietHoursTz: 'UTC',
      jurisdiction: 'MN',
      synthetic: true,
      ...overrides,
    };
  }

  it('grants only a live opted-in disclosure consent', () => {
    expect(
      consentForDisclosure({ state: discState('opted_in'), asOf: '2026-03-15T00:00:00Z' }),
    ).toBe('granted');
  });

  it('denies opted_out / blocked / pending and expired', () => {
    expect(
      consentForDisclosure({ state: discState('opted_out'), asOf: '2026-03-15T00:00:00Z' }),
    ).toBe('denied');
    expect(
      consentForDisclosure({ state: discState('blocked'), asOf: '2026-03-15T00:00:00Z' }),
    ).toBe('denied');
    expect(
      consentForDisclosure({ state: discState('pending'), asOf: '2026-03-15T00:00:00Z' }),
    ).toBe('denied');
    expect(
      consentForDisclosure({
        state: discState('opted_in', { expiresAt: '2026-01-01T00:00:00Z' }),
        asOf: '2026-03-15T00:00:00Z',
      }),
    ).toBe('denied');
  });

  it('a null ledger is unavailable (the PDP treats it as DENY)', () => {
    expect(consentForDisclosure({ state: null, asOf: '2026-03-15T00:00:00Z' })).toBe('unavailable');
  });

  it('denies a genetic disclosure lacking written authorization on record (R6-SR-031)', () => {
    expect(
      consentForDisclosure({
        state: discState('opted_in', { recordType: 'genetic' }),
        asOf: '2026-03-15T00:00:00Z',
        writtenAuthorizationOnRecord: false,
      }),
    ).toBe('denied');
  });
});

describe('applyKeyword (STOP/HELP/START)', () => {
  const base = {
    personRef: 'np-fx',
    channel: 'sms' as const,
    idBase: 'nce-kw-0001',
    inboundEvidenceRef: 'synthetic-inbound:kw-0001',
    jurisdiction: 'NV' as const,
    policyVersion: 'consent-v1',
    effectiveAt: '2026-03-01T00:00:00Z',
  };

  it('STOP revokes the channel across non-treatment purposes, carrying the inbound evidence', () => {
    const outcome = applyKeyword({ ...base, keyword: 'stop' });
    expect(outcome.kind).toBe('revoke');
    if (outcome.kind !== 'revoke') return;
    expect(
      outcome.events
        .map((event) => event.scope)
        .map((scope) => (scope.type === 'communication' ? scope.purpose : scope.type)),
    ).toEqual(['marketing', 'operations', 'payment']);
    for (const event of outcome.events) {
      expect(event.action).toBe('revoke');
      expect(event.evidenceRef).toBe('synthetic-inbound:kw-0001');
      expect(event.source).toBe('sms_keyword');
    }
  });

  it('HELP returns the org template with no ledger write', () => {
    expect(applyKeyword({ ...base, keyword: 'HELP' })).toEqual({
      kind: 'help',
      template: 'org-help',
    });
  });

  it('START re-grants transactional purposes only (marketing needs affirmative opt-in)', () => {
    const outcome = applyKeyword({ ...base, keyword: 'START' });
    expect(outcome.kind).toBe('grant');
    if (outcome.kind !== 'grant') return;
    expect(
      outcome.events.map((event) =>
        event.scope.type === 'communication' ? event.scope.purpose : event.scope.type,
      ),
    ).toEqual(['operations', 'payment']);
  });

  it('an unrecognized keyword is inert', () => {
    expect(applyKeyword({ ...base, keyword: 'hello' })).toEqual({ kind: 'unrecognized' });
  });
});
