import { describe, expect, it } from 'vitest';

import {
  appendConsentEvent,
  canonicalConsentScopeKey,
  reconstructStateAt,
  resolveConsentState,
  resultingStateForAction,
  type ConsentEvent,
  type ConsentEventInput,
} from './consent.js';

const tenant = 'northwind-synthetic';
const evidenceHash = 'ab'.repeat(32);

// Base is a sms/treatment grant, which needs no evidence; cases that require
// evidence (marketing/genetic/disclosure) add it explicitly. Omitting a key is
// how "no evidence" is expressed — exactOptionalPropertyTypes forbids passing
// an explicit `undefined`.
function commGrant(overrides: Partial<ConsentEventInput> = {}): ConsentEventInput {
  return {
    consentEventId: 'ce-0001',
    tenantId: tenant,
    personRef: 'np-fx',
    scope: { type: 'communication', channel: 'sms', purpose: 'treatment' },
    action: 'grant',
    effectiveAt: '2026-02-01T00:00:00Z',
    source: 'portal_form',
    jurisdiction: 'NV',
    policyVersion: 'consent-v1',
    synthetic: true,
    ...overrides,
  };
}

const build = (input: ConsentEventInput): ConsentEvent => appendConsentEvent([], input).event;

describe('resultingStateForAction', () => {
  it('maps every action to its paired state', () => {
    expect(resultingStateForAction('grant')).toBe('opted_in');
    expect(resultingStateForAction('renew')).toBe('opted_in');
    expect(resultingStateForAction('revoke')).toBe('opted_out');
    expect(resultingStateForAction('expire')).toBe('expired');
    expect(resultingStateForAction('block')).toBe('blocked');
    expect(resultingStateForAction('unblock')).toBe('pending');
  });
});

describe('canonicalConsentScopeKey', () => {
  it('never collides across the two axes', () => {
    const comm = canonicalConsentScopeKey({
      type: 'communication',
      channel: 'sms',
      purpose: 'marketing',
    });
    const disc = canonicalConsentScopeKey({
      type: 'disclosure',
      purpose: 'marketing',
      recipient: 'synthetic-recipient:r-1',
      recordType: 'general',
    });
    expect(comm).toBe('communication|channel=sms|purpose=marketing');
    expect(disc.startsWith('disclosure|')).toBe(true);
    expect(comm).not.toBe(disc);
  });
});

describe('appendConsentEvent', () => {
  it('materializes a valid grant into opted_in with a scope key', () => {
    const event = build(commGrant());
    expect(event.resultingState).toBe('opted_in');
    expect(event.scopeType).toBe('communication');
    expect(event.scopeKey).toBe('communication|channel=sms|purpose=treatment');
    expect(event.occurredAt).toBe(event.effectiveAt);
    expect(event.partitionTags).toEqual([]);
  });

  it('refuses a marketing grant without an affirmative evidenced source (R6-SR-020)', () => {
    expect(() =>
      build(
        commGrant({
          scope: { type: 'communication', channel: 'sms', purpose: 'marketing' },
          source: 'api_import',
          evidenceRef: 'synthetic-consent:ce-import',
        }),
      ),
    ).toThrow(/affirmative/);
    expect(() =>
      build(
        commGrant({
          scope: { type: 'communication', channel: 'sms', purpose: 'marketing' },
          source: 'double_optin',
        }),
      ),
    ).toThrow(/affirmative/);
    // An affirmative evidenced marketing grant is accepted.
    const ok = build(
      commGrant({
        scope: { type: 'communication', channel: 'sms', purpose: 'marketing' },
        source: 'double_optin',
        evidenceRef: 'synthetic-consent:ce-optin',
      }),
    );
    expect(ok.resultingState).toBe('opted_in');
  });

  it('refuses a genetic grant without written authorization (R6-SR-031)', () => {
    expect(() =>
      build(
        commGrant({
          scope: {
            type: 'disclosure',
            purpose: 'treatment',
            recipient: 'synthetic-recipient:lab-1',
            recordType: 'genetic',
          },
        }),
      ),
    ).toThrow(/genetic/);
  });

  it('refuses a disclosure grant without written consent (R6-SR-040)', () => {
    expect(() =>
      build(
        commGrant({
          scope: {
            type: 'disclosure',
            purpose: 'treatment',
            recipient: 'synthetic-recipient:r-1',
            recordType: 'general',
          },
        }),
      ),
    ).toThrow(/written consent/);
  });

  it('rejects malformed inputs and an expiry before the effective date', () => {
    expect(() => build(commGrant({ jurisdiction: 'CA' as never }))).toThrow(/jurisdiction/);
    expect(() => build(commGrant({ personRef: 'Bad Ref!' }))).toThrow(/personRef/);
    expect(() => build(commGrant({ evidenceHash: 'nope' }))).toThrow(/sha-256/);
    expect(() =>
      build(commGrant({ effectiveAt: '2026-02-01T00:00:00Z', expiresAt: '2025-01-01T00:00:00Z' })),
    ).toThrow(/precedes/);
  });

  it('carries evidenceHash and partition tags through', () => {
    const event = build(
      commGrant({
        evidenceRef: 'synthetic-consent:genetic-1',
        evidenceHash,
        scope: {
          type: 'disclosure',
          purpose: 'treatment',
          recipient: 'synthetic-recipient:lab-1',
          recordType: 'genetic',
        },
        partitionTags: ['gipa-genetic'],
        policyVersion: 'genetic-v1',
      }),
    );
    expect(event.evidenceHash).toBe(evidenceHash);
    expect(event.partitionTags).toEqual(['gipa-genetic']);
    expect(event.recordType).toBe('genetic');
  });
});

describe('foldConsentState / resolveConsentState', () => {
  const events: ConsentEvent[] = [
    build(commGrant({ consentEventId: 'ce-1', effectiveAt: '2026-02-01T00:00:00Z' })),
    build(
      commGrant({
        consentEventId: 'ce-2',
        action: 'revoke',
        source: 'sms_keyword',
        effectiveAt: '2026-03-01T00:00:00Z',
      }),
    ),
  ];

  it('the latest-effective event governs the projection', () => {
    const row = resolveConsentState(events, 'np-fx', {
      type: 'communication',
      channel: 'sms',
      purpose: 'treatment',
    });
    expect(row?.currentState).toBe('opted_out');
    expect(row?.lastEventId).toBe('ce-2');
  });

  it('an absent scope folds to null (the fail-closed case)', () => {
    expect(
      resolveConsentState(events, 'np-fx', {
        type: 'communication',
        channel: 'ai_voice',
        purpose: 'treatment',
      }),
    ).toBeNull();
  });

  it('an equal effective time breaks to the later append', () => {
    const same: ConsentEvent[] = [
      build(commGrant({ consentEventId: 'ce-a', effectiveAt: '2026-02-01T00:00:00Z' })),
      build(
        commGrant({
          consentEventId: 'ce-b',
          action: 'block',
          effectiveAt: '2026-02-01T00:00:00Z',
        }),
      ),
    ];
    expect(
      resolveConsentState(same, 'np-fx', {
        type: 'communication',
        channel: 'sms',
        purpose: 'treatment',
      })?.currentState,
    ).toBe('blocked');
  });
});

describe('reconstructStateAt (R6-SR-042 point-in-time)', () => {
  const events: ConsentEvent[] = [
    build(commGrant({ consentEventId: 'ce-1', effectiveAt: '2026-02-01T00:00:00Z' })),
    build(
      commGrant({
        consentEventId: 'ce-2',
        action: 'revoke',
        source: 'sms_keyword',
        effectiveAt: '2026-03-01T00:00:00Z',
      }),
    ),
  ];
  const scope = {
    type: 'communication' as const,
    channel: 'sms' as const,
    purpose: 'treatment' as const,
  };

  it('reproduces the state as of a past date, before a later revoke', () => {
    expect(reconstructStateAt(events, 'np-fx', scope, '2026-02-15T00:00:00Z')?.currentState).toBe(
      'opted_in',
    );
    expect(reconstructStateAt(events, 'np-fx', scope, '2026-03-15T00:00:00Z')?.currentState).toBe(
      'opted_out',
    );
  });

  it('is null before the first event', () => {
    expect(reconstructStateAt(events, 'np-fx', scope, '2026-01-01T00:00:00Z')).toBeNull();
  });
});
