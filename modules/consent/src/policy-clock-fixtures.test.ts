/**
 * Executable 4-class fixture packs for the WP-019 owned slice (R6-SR-041 MHRA
 * renewal, R6-SR-102 statute-tracker, R6-REQ-010 records-request closure,
 * REQ-ADM-031 MHRA release-consent expiry+renewal enforcement). Every case runs
 * the real domain functions — a fixture that merely "exists" cannot pass here.
 * Governance clock actions (satisfy/cancel) emit through the REAL
 * @practicehub/audit-evidence emitter, proving the R6-REQ-006/052 evidence trail.
 *
 * Review-009 discipline: the accepted-op list is validated at LOAD, and the
 * dispatcher ends in a throwing default.
 */
import { fileURLToPath } from 'node:url';

import { emitAuditEvent, emptyChainState } from '@practicehub/audit-evidence';
import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import {
  addDays,
  cancelClock,
  clockWorkItem,
  computeClockStatus,
  escalateClock,
  mhraReleaseDecision,
  recordClockSatisfaction,
  resolveObligationClockPolicy,
  rulePackReviewWorkItem,
  runRenewalExpiry,
  triggerClock,
  type ClockAuditInput,
  type MhraReleaseBasis,
  type ObligationType,
} from './clocks.js';
import { consentForDisclosure } from './cansend.js';
import {
  appendConsentEvent,
  resolveConsentState,
  type ConsentEvent,
  type ConsentEventInput,
  type ConsentRecordType,
} from './consent.js';
import { resolvePolicyDocument } from './policy-registry.js';
import { obligationClockPoliciesV1, syntheticPolicyDocumentsV1 } from './policy-clock-seed.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));
const tenant = 'northwind-synthetic';
const policies = obligationClockPoliciesV1;

const acceptedOps = [
  'policy-resolve',
  'trigger',
  'status',
  'lifecycle',
  'renewal-expiry',
  'workitem',
  'policy-doc',
  'consent-enforce',
  'renew-lineage',
  'mhra-release',
] as const;
type FixtureOp = (typeof acceptedOps)[number];

interface ClockSpec {
  readonly obligationType: ObligationType;
  readonly triggeredAt?: string;
  readonly providerState?: string | null;
  readonly patientState?: string | null;
  readonly anchorDueAt?: string;
  readonly subjectRef?: string;
}

interface ConsentSpec {
  readonly recipient?: string;
  readonly recordType?: ConsentRecordType;
  readonly effectiveAt: string;
  readonly expiresAt?: string;
  readonly action?: 'grant' | 'renew' | 'expire';
}

type ReleaseBasis = MhraReleaseBasis;

interface FixtureCase {
  readonly name: string;
  readonly op: FixtureOp;
  readonly expectError?: string;
  // clock spec
  readonly clock?: ClockSpec;
  readonly asOf?: string;
  readonly renewalRecorded?: boolean;
  readonly escalateAt?: string;
  readonly satisfyAt?: string;
  readonly cancelAt?: string;
  // rule-pack-review structured closure (R6-SR-102)
  readonly changeControlRef?: string;
  readonly truthTableReceiptRef?: string;
  // mhra-release exception (REQ-ADM-031; C-06)
  readonly disclosureConsentActive?: boolean;
  readonly basis?: ReleaseBasis;
  readonly expectPermitted?: boolean;
  // renew-lineage (REQ-ADM-031 AC-3)
  readonly expectSupersedes?: string;
  // policy-resolve
  readonly obligationType?: ObligationType;
  readonly providerState?: string | null;
  readonly patientState?: string | null;
  // policy-doc
  readonly documentType?: string;
  readonly jurisdiction?: string;
  // consent-enforce
  readonly consent?: readonly ConsentSpec[];
  // expectations
  readonly expectDurationDays?: number;
  readonly expectEscalationLeadDays?: number;
  readonly expectDefaultsApplied?: boolean;
  readonly expectCounselReviewPending?: boolean;
  readonly expectDueOffsetDays?: number;
  readonly expectDueAt?: string;
  readonly expectStatus?: string;
  readonly expectOwnerRole?: string;
  readonly expectFired?: boolean;
  readonly expectExpireAction?: string;
  readonly expectDirective?: string;
  readonly expectRulePackScope?: string;
  readonly expectAuditAction?: string;
  readonly expectVersion?: number;
  readonly expectJurisdiction?: string;
  readonly expectFallbackToBase?: boolean;
  readonly expectAnswer?: 'granted' | 'denied' | 'unavailable';
}

interface ClockFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly cases: readonly FixtureCase[];
}

const DEFAULT_TRIGGER = '2026-01-01T00:00:00.000Z';

function triggerFrom(spec: ClockSpec, clockId = 'clk-fx', eventId = 'cle-fx-1') {
  const triggeredAt = spec.triggeredAt ?? DEFAULT_TRIGGER;
  return triggerClock({
    tenantId: tenant,
    clockId,
    clockEventId: eventId,
    obligationType: spec.obligationType,
    subjectRef: spec.subjectRef ?? 'np-fx',
    triggerRef: 'fixture:fx',
    triggeredAt,
    actorRef: 'synthetic-clock',
    basis: {
      providerState: spec.providerState ?? null,
      patientState: spec.patientState ?? null,
    },
    ...(spec.anchorDueAt !== undefined ? { anchorDueAt: spec.anchorDueAt } : {}),
    policies,
  });
}

function emitAndAssert(auditInput: ClockAuditInput, expectedAction?: string): void {
  const emitted = emitAuditEvent(emptyChainState, {
    ...auditInput,
    auditId: 'fx-clock-audit-0001',
  });
  expect(emitted.record.entryHash).toMatch(/^[0-9a-f]{64}$/);
  if (expectedAction !== undefined) {
    expect(emitted.record.action).toBe(expectedAction);
  }
}

function buildConsentLog(specs: readonly ConsentSpec[]): readonly ConsentEvent[] {
  let log: readonly ConsentEvent[] = [];
  specs.forEach((spec, index) => {
    const action = spec.action ?? 'grant';
    const input: ConsentEventInput = {
      consentEventId: `nce-fx-${index + 1}`,
      tenantId: tenant,
      personRef: 'np-fx',
      scope: {
        type: 'disclosure',
        purpose: 'treatment',
        recipient: spec.recipient ?? 'synthetic-recipient:fx',
        recordType: spec.recordType ?? 'general',
      },
      action,
      effectiveAt: spec.effectiveAt,
      ...(spec.expiresAt !== undefined ? { expiresAt: spec.expiresAt } : {}),
      source: 'paper_form',
      ...(action === 'expire' ? {} : { evidenceRef: `synthetic-consent:nce-fx-${index + 1}` }),
      // REQ-ADM-031 AC-3: a disclosure renewal is versioned WITH lineage to the
      // consent it renews (the immediately-prior event in the log).
      ...(action === 'renew' && index > 0 ? { supersedesConsentEventId: `nce-fx-${index}` } : {}),
      jurisdiction: 'MN',
      policyVersion: 'records-consent-v1',
      synthetic: true,
    };
    ({ log } = appendConsentEvent(log, input));
  });
  return log;
}

function runCase(fixtureCase: FixtureCase): void {
  switch (fixtureCase.op) {
    case 'policy-resolve': {
      const resolution = resolveObligationClockPolicy(
        policies,
        fixtureCase.obligationType as ObligationType,
        {
          providerState: fixtureCase.providerState ?? null,
          patientState: fixtureCase.patientState ?? null,
        },
        fixtureCase.asOf,
      );
      if (fixtureCase.expectDurationDays !== undefined) {
        expect(resolution.durationDays).toBe(fixtureCase.expectDurationDays);
      }
      if (fixtureCase.expectEscalationLeadDays !== undefined) {
        expect(resolution.escalationLeadDays).toBe(fixtureCase.expectEscalationLeadDays);
      }
      if (fixtureCase.expectDefaultsApplied !== undefined) {
        expect(resolution.defaultsApplied).toBe(fixtureCase.expectDefaultsApplied);
      }
      if (fixtureCase.expectCounselReviewPending !== undefined) {
        expect(resolution.counselReviewPending).toBe(fixtureCase.expectCounselReviewPending);
      }
      break;
    }
    case 'trigger': {
      if (fixtureCase.expectError !== undefined) {
        expect(() => triggerFrom(fixtureCase.clock as ClockSpec)).toThrow(fixtureCase.expectError);
        break;
      }
      const { instance } = triggerFrom(fixtureCase.clock as ClockSpec);
      if (fixtureCase.expectDueOffsetDays !== undefined) {
        expect(instance.dueAt).toBe(
          addDays(
            fixtureCase.clock?.triggeredAt ?? DEFAULT_TRIGGER,
            fixtureCase.expectDueOffsetDays,
          ),
        );
      }
      if (fixtureCase.expectDueAt !== undefined) {
        expect(instance.dueAt).toBe(fixtureCase.expectDueAt);
      }
      if (fixtureCase.expectStatus !== undefined) {
        expect(instance.status).toBe(fixtureCase.expectStatus);
      }
      if (fixtureCase.expectOwnerRole !== undefined) {
        expect(instance.ownerRole).toBe(fixtureCase.expectOwnerRole);
      }
      break;
    }
    case 'status': {
      const { instance } = triggerFrom(fixtureCase.clock as ClockSpec);
      expect(computeClockStatus(instance, fixtureCase.asOf as string)).toBe(
        fixtureCase.expectStatus,
      );
      break;
    }
    case 'lifecycle': {
      const { instance } = triggerFrom(fixtureCase.clock as ClockSpec);
      const escalated = escalateClock(instance, {
        clockEventId: 'cle-fx-2',
        occurredAt: fixtureCase.escalateAt ?? instance.escalateAt,
        actorRef: 'synthetic-clock',
      });
      expect(escalated.instance.status).toBe('escalated');
      if (fixtureCase.cancelAt !== undefined) {
        const cancelled = cancelClock(escalated.instance, {
          clockEventId: 'cle-fx-3',
          occurredAt: fixtureCase.cancelAt,
          actorRef: 'synthetic-officer',
          reason: 'obligation mooted',
        });
        expect(cancelled.instance.status).toBe('cancelled');
        emitAndAssert(cancelled.auditInput, fixtureCase.expectAuditAction);
        break;
      }
      // R6-SR-102: a rule-pack-review clock closes with STRUCTURED evidence (a
      // change-control ref + the truth-table regeneration receipt); every other
      // obligation type closes with a single evidence ref.
      const isRulePack = escalated.instance.obligationType === 'rule-pack-review';
      const satisfied = isRulePack
        ? recordClockSatisfaction(escalated.instance, {
            clockEventId: 'cle-fx-3',
            occurredAt: fixtureCase.satisfyAt ?? instance.dueAt,
            actorRef: 'synthetic-officer',
            closureEvidence: {
              changeControlRef: fixtureCase.changeControlRef ?? 'ccr-statute-fx',
              truthTableReceiptRef:
                fixtureCase.truthTableReceiptRef ?? 'truth-table:regen:cells-432-diffs-0',
            },
          })
        : recordClockSatisfaction(escalated.instance, {
            clockEventId: 'cle-fx-3',
            occurredAt: fixtureCase.satisfyAt ?? instance.dueAt,
            actorRef: 'synthetic-officer',
            evidenceRef: 'clock-closure:fx',
          });
      expect(satisfied.instance.status).toBe(fixtureCase.expectStatus ?? 'satisfied');
      expect(satisfied.instance.closureEvidenceRef).toBe(
        isRulePack ? (fixtureCase.changeControlRef ?? 'ccr-statute-fx') : 'clock-closure:fx',
      );
      if (isRulePack) {
        expect(satisfied.event.truthTableReceiptRef).toBe(
          fixtureCase.truthTableReceiptRef ?? 'truth-table:regen:cells-432-diffs-0',
        );
      }
      emitAndAssert(satisfied.auditInput, fixtureCase.expectAuditAction);
      break;
    }
    case 'renewal-expiry': {
      const { instance } = triggerFrom(fixtureCase.clock as ClockSpec);
      const outcome = runRenewalExpiry({
        instance,
        asOf: fixtureCase.asOf as string,
        renewalRecorded: fixtureCase.renewalRecorded ?? false,
        personRef: 'np-fx',
        scope: {
          type: 'disclosure',
          purpose: 'treatment',
          recipient: 'synthetic-recipient:fx',
          recordType: 'general',
        },
        jurisdiction: 'MN',
        policyVersion: 'records-consent-v1',
        expireEventId: 'nce-fx-expire',
        expireClockEventId: 'cle-fx-expire',
        actorRef: 'synthetic-clock',
      });
      expect(outcome.fired).toBe(fixtureCase.expectFired);
      if (outcome.fired && fixtureCase.expectExpireAction !== undefined) {
        expect(outcome.consentExpireEvent.action).toBe(fixtureCase.expectExpireAction);
      }
      break;
    }
    case 'workitem': {
      const { instance } = triggerFrom(fixtureCase.clock as ClockSpec);
      const workItem =
        instance.obligationType === 'rule-pack-review'
          ? rulePackReviewWorkItem(instance, fixtureCase.asOf as string)
          : clockWorkItem(instance, fixtureCase.asOf as string);
      if (fixtureCase.expectDirective !== undefined) {
        expect(workItem.directive).toContain(fixtureCase.expectDirective);
      }
      if (fixtureCase.expectOwnerRole !== undefined) {
        expect(workItem.ownerRole).toBe(fixtureCase.expectOwnerRole);
      }
      if (fixtureCase.expectStatus !== undefined) {
        expect(workItem.status).toBe(fixtureCase.expectStatus);
      }
      if (fixtureCase.expectRulePackScope !== undefined) {
        expect((workItem as { rulePackScopeRef?: string }).rulePackScopeRef).toBe(
          fixtureCase.expectRulePackScope,
        );
      }
      break;
    }
    case 'policy-doc': {
      if (fixtureCase.expectError !== undefined) {
        expect(() =>
          resolvePolicyDocument(
            syntheticPolicyDocumentsV1,
            tenant,
            fixtureCase.documentType as 'disclosure-authorization',
            fixtureCase.jurisdiction as string,
            fixtureCase.asOf,
          ),
        ).toThrow(fixtureCase.expectError);
        break;
      }
      const resolution = resolvePolicyDocument(
        syntheticPolicyDocumentsV1,
        tenant,
        fixtureCase.documentType as 'disclosure-authorization',
        fixtureCase.jurisdiction as string,
        fixtureCase.asOf,
      );
      if (fixtureCase.expectVersion !== undefined) {
        expect(resolution.version).toBe(fixtureCase.expectVersion);
      }
      if (fixtureCase.expectJurisdiction !== undefined) {
        expect(resolution.jurisdiction).toBe(fixtureCase.expectJurisdiction);
      }
      if (fixtureCase.expectFallbackToBase !== undefined) {
        expect(resolution.fallbackToBase).toBe(fixtureCase.expectFallbackToBase);
      }
      break;
    }
    case 'consent-enforce': {
      const log = buildConsentLog(fixtureCase.consent as readonly ConsentSpec[]);
      const state = resolveConsentState(log, 'np-fx', {
        type: 'disclosure',
        purpose: 'treatment',
        recipient: fixtureCase.consent?.[0]?.recipient ?? 'synthetic-recipient:fx',
        recordType: fixtureCase.consent?.[0]?.recordType ?? 'general',
      });
      const answer = consentForDisclosure({ state, asOf: fixtureCase.asOf as string });
      expect(answer).toBe(fixtureCase.expectAnswer);
      break;
    }
    case 'renew-lineage': {
      // REQ-ADM-031 AC-3: the renewed consent is versioned WITH lineage to the
      // old consent — a disclosure renew that names no predecessor is refused.
      const specs = fixtureCase.consent as readonly ConsentSpec[];
      const log = buildConsentLog(specs);
      const renewEvent = [...log].reverse().find((event) => event.action === 'renew');
      expect(renewEvent, 'a renew event must exist').toBeDefined();
      expect(renewEvent?.supersedesConsentEventId).toBe(fixtureCase.expectSupersedes);
      // and a disclosure renew WITHOUT lineage fails closed.
      expect(() =>
        appendConsentEvent([], {
          consentEventId: 'nce-fx-no-lineage',
          tenantId: tenant,
          personRef: 'np-fx',
          scope: {
            type: 'disclosure',
            purpose: 'treatment',
            recipient: 'synthetic-recipient:fx',
            recordType: 'general',
          },
          action: 'renew',
          effectiveAt: specs[specs.length - 1]?.effectiveAt ?? '2026-01-01T00:00:00.000Z',
          source: 'paper_form',
          evidenceRef: 'synthetic-consent:no-lineage',
          jurisdiction: 'MN',
          policyVersion: 'records-consent-v1',
          synthetic: true,
        }),
      ).toThrow(/lineage/);
      break;
    }
    case 'mhra-release': {
      // REQ-ADM-031 / ADR-007 C-06: expiry blocks third-party disclosure only;
      // the patient's own access and an urgent-care release are never blocked.
      const decision = mhraReleaseDecision({
        disclosureConsentActive: fixtureCase.disclosureConsentActive ?? false,
        basis: fixtureCase.basis as ReleaseBasis,
      });
      expect(decision.permitted).toBe(fixtureCase.expectPermitted);
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

// WP-019-exclusive owned slice. R6-SR-041 is co-owned with WP-018, which already
// fixtures its canSend auto-block half; WP-019's renewal-clock half is fixtured
// here under REQ-ADM-031 ("MHRA release-consent expiry and renewal enforcement").
const ownedRequirements = ['R6-SR-102', 'R6-REQ-010', 'REQ-ADM-031'];

for (const requirementId of ownedRequirements) {
  describe(`${requirementId} fixture pack (4-class floor)`, () => {
    const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);

    it('carries all four fixture classes with the synthetic watermark', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
    });

    it('every case declares a recognized op (load-time validation, review-009)', () => {
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as unknown as ClockFixture;
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
        const fixture = pack.fixtures[fixtureClass] as unknown as ClockFixture;
        for (const fixtureCase of fixture.cases) {
          it(fixtureCase.name, () => {
            runCase(fixtureCase);
          });
        }
      });
    }
  });
}
