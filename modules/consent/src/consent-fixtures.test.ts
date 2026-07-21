/**
 * Executable 4-class fixture packs for the WP-018 requirement slice
 * (R6-REQ-070/071/072/074, R6-SR-020/031/040/041/042). Every case runs against
 * the real domain functions — a fixture that merely "exists" without encoding
 * its acceptance criterion cannot pass here. The consent-event audit input of
 * every canSend decision is emitted through the REAL @practicehub/audit-evidence
 * emitter, proving post-STOP send prevention is auditable (R6-REQ-024).
 *
 * Review-009 discipline: the accepted-op list is validated at LOAD (an unknown
 * op fails the pack's structural test, not silently), and the dispatcher ends in
 * a throwing default.
 */
import { fileURLToPath } from 'node:url';

import { emitAuditEvent, emptyChainState } from '@practicehub/audit-evidence';
import { jurisdictionPacksV1 } from '@practicehub/platform-core';
import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import {
  applyKeyword,
  canSend,
  consentForDisclosure,
  type CanSendInput,
  type ConsentAnswer,
} from './cansend.js';
import {
  appendConsentEvent,
  affirmativeConsentSources,
  reconstructStateAt,
  resolveConsentState,
  type ConsentChannel,
  type ConsentEvent,
  type ConsentEventInput,
  type ConsentJurisdiction,
  type ConsentPurpose,
  type ConsentRecordType,
  type ConsentScope,
  type ConsentSource,
  type ConsentStateValue,
} from './consent.js';
import { communicationOverlay, consentBasis } from './overlays.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));
const tenant = 'northwind-synthetic';

const acceptedOps = [
  'append',
  'fold',
  'reconstruct',
  'cansend',
  'port',
  'keyword',
  'overlay',
] as const;
type FixtureOp = (typeof acceptedOps)[number];

interface ScopeSpec {
  readonly type: 'communication' | 'disclosure';
  readonly channel?: ConsentChannel;
  readonly purpose: ConsentPurpose;
  readonly recipient?: string;
  readonly recordType?: ConsentRecordType;
}

interface EventSpec {
  readonly id: string;
  readonly personRef?: string;
  readonly scope: ScopeSpec;
  readonly action: 'grant' | 'revoke' | 'expire' | 'block' | 'unblock' | 'renew';
  readonly effectiveAt: string;
  readonly expiresAt?: string;
  readonly source?: ConsentSource;
  readonly evidence?: boolean;
  readonly jurisdiction?: ConsentJurisdiction;
  readonly partitionTags?: readonly ('gipa-genetic' | 'chd' | 'biometric' | 'part2')[];
}

interface FixtureCase {
  readonly name: string;
  readonly op: FixtureOp;
  readonly expectError?: string;
  readonly events?: readonly EventSpec[];
  readonly event?: EventSpec;
  readonly personRef?: string;
  readonly scope?: ScopeSpec;
  readonly urgency?: 'routine' | 'urgent';
  readonly asOf?: string;
  readonly localHour?: number;
  readonly carrierStopSet?: boolean;
  readonly governingSourceAffirmative?: boolean;
  readonly overlayFrom?: { readonly jurisdiction: ConsentJurisdiction };
  readonly writtenAuthorizationOnRecord?: boolean;
  readonly keyword?: string;
  readonly expectAllow?: boolean;
  readonly expectReason?: string;
  readonly expectAnswer?: ConsentAnswer;
  readonly expectState?: ConsentStateValue | null;
  readonly expectResultingState?: ConsentStateValue;
  readonly expectScopeKey?: string;
  readonly expectKind?: string;
  readonly expectPurposes?: readonly ConsentPurpose[];
  readonly expectChdOptIn?: boolean;
  readonly expectAiDisclosure?: boolean;
  readonly expectAuditDecision?: 'allow' | 'deny';
}

interface ConsentFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly cases: readonly FixtureCase[];
}

function toScope(spec: ScopeSpec): ConsentScope {
  if (spec.type === 'communication') {
    return { type: 'communication', channel: spec.channel ?? 'sms', purpose: spec.purpose };
  }
  return {
    type: 'disclosure',
    purpose: spec.purpose,
    recipient: spec.recipient ?? 'synthetic-recipient:fx',
    recordType: spec.recordType ?? 'general',
  };
}

function toInput(spec: EventSpec): ConsentEventInput {
  const source: ConsentSource = spec.source ?? 'portal_form';
  return {
    consentEventId: spec.id,
    tenantId: tenant,
    personRef: spec.personRef ?? 'np-fx',
    scope: toScope(spec.scope),
    action: spec.action,
    effectiveAt: spec.effectiveAt,
    ...(spec.expiresAt !== undefined ? { expiresAt: spec.expiresAt } : {}),
    source,
    ...(spec.evidence === true ? { evidenceRef: `synthetic-consent:${spec.id}` } : {}),
    jurisdiction: spec.jurisdiction ?? 'NV',
    policyVersion: 'consent-fixture-v1',
    ...(spec.partitionTags !== undefined ? { partitionTags: spec.partitionTags } : {}),
    synthetic: true,
  };
}

function buildLog(specs: readonly EventSpec[]): readonly ConsentEvent[] {
  let log: readonly ConsentEvent[] = [];
  for (const spec of specs) {
    ({ log } = appendConsentEvent(log, toInput(spec)));
  }
  return log;
}

function runCase(fixtureCase: FixtureCase): void {
  switch (fixtureCase.op) {
    case 'append': {
      const spec = fixtureCase.event as EventSpec;
      if (fixtureCase.expectError !== undefined) {
        expect(() => appendConsentEvent([], toInput(spec))).toThrow(fixtureCase.expectError);
        break;
      }
      const { event } = appendConsentEvent([], toInput(spec));
      if (fixtureCase.expectResultingState !== undefined) {
        expect(event.resultingState).toBe(fixtureCase.expectResultingState);
      }
      if (fixtureCase.expectScopeKey !== undefined) {
        expect(event.scopeKey).toBe(fixtureCase.expectScopeKey);
      }
      break;
    }
    case 'fold': {
      const log = buildLog(fixtureCase.events ?? []);
      const row = resolveConsentState(
        log,
        fixtureCase.personRef ?? 'np-fx',
        toScope(fixtureCase.scope as ScopeSpec),
      );
      expect(row?.currentState ?? null).toBe(fixtureCase.expectState ?? null);
      break;
    }
    case 'reconstruct': {
      const log = buildLog(fixtureCase.events ?? []);
      const row = reconstructStateAt(
        log,
        fixtureCase.personRef ?? 'np-fx',
        toScope(fixtureCase.scope as ScopeSpec),
        fixtureCase.asOf as string,
      );
      expect(row?.currentState ?? null).toBe(fixtureCase.expectState ?? null);
      break;
    }
    case 'cansend': {
      const scope = fixtureCase.scope as ScopeSpec;
      const channel = scope.channel ?? 'sms';
      const log = buildLog(fixtureCase.events ?? []);
      const state = resolveConsentState(log, fixtureCase.personRef ?? 'np-fx', toScope(scope));
      const overlay =
        fixtureCase.overlayFrom !== undefined
          ? communicationOverlay(
              jurisdictionPacksV1,
              consentBasis(
                fixtureCase.overlayFrom.jurisdiction,
                fixtureCase.overlayFrom.jurisdiction,
              ),
              scope.purpose,
              channel,
            )
          : undefined;
      // Derive the affirmative flag from the governing event unless the fixture
      // pins it (the migrated-gap CHD case pins false).
      const governing = state
        ? [...log].reverse().find((event) => event.consentEventId === state.lastEventId)
        : undefined;
      const derivedAffirmative =
        governing !== undefined && affirmativeConsentSources.includes(governing.source);
      const request: CanSendInput = {
        tenantId: tenant,
        personRef: fixtureCase.personRef ?? 'np-fx',
        channel,
        purpose: scope.purpose,
        state,
        urgency: fixtureCase.urgency ?? 'routine',
        asOf: fixtureCase.asOf ?? '2026-03-15T00:00:00Z',
        ...(fixtureCase.localHour !== undefined ? { localHour: fixtureCase.localHour } : {}),
        ...(fixtureCase.carrierStopSet !== undefined
          ? { carrierStopSet: fixtureCase.carrierStopSet }
          : {}),
        ...(overlay !== undefined ? { overlay } : {}),
        governingSourceAffirmative: fixtureCase.governingSourceAffirmative ?? derivedAffirmative,
        actorRef: 'synthetic-staff:fixture',
        occurredAt: '2026-03-15T09:00:00Z',
      };
      const decision = canSend(request);
      if (fixtureCase.expectAllow !== undefined) {
        expect(decision.allow).toBe(fixtureCase.expectAllow);
      }
      if (fixtureCase.expectReason !== undefined) {
        expect(decision.reason).toBe(fixtureCase.expectReason);
      }
      // The decision's audit input emits and chains through the real emitter —
      // the emit wiring assigns the unique audit id (as PDP does).
      const emitted = emitAuditEvent(emptyChainState, {
        ...decision.auditInput,
        auditId: 'fx-consent-audit-0001',
      });
      expect(emitted.record.entryHash).toMatch(/^[0-9a-f]{64}$/);
      if (fixtureCase.expectAuditDecision !== undefined) {
        expect(emitted.record.decision).toBe(fixtureCase.expectAuditDecision);
      }
      break;
    }
    case 'port': {
      const scope = fixtureCase.scope as ScopeSpec;
      const log = buildLog(fixtureCase.events ?? []);
      const state = resolveConsentState(log, fixtureCase.personRef ?? 'np-fx', toScope(scope));
      const answer = consentForDisclosure({
        state,
        asOf: fixtureCase.asOf ?? '2026-03-15T00:00:00Z',
        ...(fixtureCase.writtenAuthorizationOnRecord !== undefined
          ? { writtenAuthorizationOnRecord: fixtureCase.writtenAuthorizationOnRecord }
          : {}),
      });
      expect(answer).toBe(fixtureCase.expectAnswer);
      break;
    }
    case 'keyword': {
      const outcome = applyKeyword({
        personRef: fixtureCase.personRef ?? 'np-fx',
        channel: 'sms',
        keyword: fixtureCase.keyword as string,
        idBase: 'nce-fx-kw',
        inboundEvidenceRef: 'synthetic-inbound:fx-kw',
        jurisdiction: 'NV',
        policyVersion: 'consent-fixture-v1',
        effectiveAt: fixtureCase.asOf ?? '2026-03-15T00:00:00Z',
      });
      expect(outcome.kind).toBe(fixtureCase.expectKind);
      if (
        fixtureCase.expectPurposes !== undefined &&
        (outcome.kind === 'revoke' || outcome.kind === 'grant')
      ) {
        expect(
          outcome.events.map((event) =>
            event.scope.type === 'communication' ? event.scope.purpose : event.scope.type,
          ),
        ).toEqual(fixtureCase.expectPurposes);
      }
      break;
    }
    case 'overlay': {
      const scope = fixtureCase.scope as ScopeSpec;
      const jurisdiction = fixtureCase.overlayFrom?.jurisdiction ?? 'NV';
      const overlay = communicationOverlay(
        jurisdictionPacksV1,
        consentBasis(jurisdiction, jurisdiction),
        scope.purpose,
        scope.channel ?? 'sms',
      );
      if (fixtureCase.expectChdOptIn !== undefined) {
        expect(overlay.chdOptInRequired).toBe(fixtureCase.expectChdOptIn);
      }
      if (fixtureCase.expectAiDisclosure !== undefined) {
        expect(overlay.aiDisclosureRequired).toBe(fixtureCase.expectAiDisclosure);
      }
      break;
    }
    default: {
      throw new Error(
        `unrecognized fixture op ${JSON.stringify((fixtureCase as { op: string }).op)} — ` +
          'the dispatcher refuses unknown cases (review-009)',
      );
    }
  }
}

const ownedRequirements = [
  'R6-REQ-070',
  'R6-REQ-071',
  'R6-REQ-072',
  'R6-REQ-074',
  'R6-SR-020',
  'R6-SR-031',
  'R6-SR-040',
  'R6-SR-041',
  'R6-SR-042',
];

for (const requirementId of ownedRequirements) {
  describe(`${requirementId} fixture pack (4-class floor)`, () => {
    const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);

    it('carries all four fixture classes with the synthetic watermark', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
    });

    it('every case declares a recognized op (load-time validation, review-009)', () => {
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as unknown as ConsentFixture;
        expect(fixture.cases.length).toBeGreaterThan(0);
        for (const fixtureCase of fixture.cases) {
          expect(
            (acceptedOps as readonly string[]).includes(fixtureCase.op),
            `${fixtureClass}: unknown op ${JSON.stringify(fixtureCase.op)}`,
          ).toBe(true);
        }
      }
    });

    for (const fixtureClass of requiredFixtureClasses) {
      describe(fixtureClass, () => {
        const fixture = pack.fixtures[fixtureClass] as unknown as ConsentFixture;
        for (const fixtureCase of fixture.cases) {
          it(fixtureCase.name, () => {
            runCase(fixtureCase);
          });
        }
      });
    }
  });
}
