/**
 * Executable 4-class fixture packs for the WP-020 requirement slice
 * (R6-REQ-001, R6-REQ-102, R6-REQ-052, R6-SR-080). Every case runs against
 * the real domain functions — a fixture that merely "exists" without
 * encoding its acceptance criterion cannot pass here.
 *
 * Review-009 discipline: the accepted-op list is validated at LOAD (an
 * unknown op fails the pack's structural test, not silently), and the
 * dispatcher ends in a throwing default.
 */
import { fileURLToPath } from 'node:url';

import { jurisdictionPacksV1 } from '@practicehub/platform-core';
import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import type { AuthorityDecision } from '@practicehub/platform-core';

import {
  auditInputForAuthorityDecision,
  auditTrailForSubject,
  emitAuditEvent,
  emptyChainState,
  exportAuditSlice,
  reconstructAiInteractions,
  runAuditedOperation,
  verifyAuditChain,
  type AuditChainState,
  type AuditEmitInput,
  type AuditRecord,
} from './audit.js';
import {
  evaluateDestructionEligibility,
  evaluateExportExpiry,
  executeDestruction,
  releaseLegalHold,
  resolveRetentionClock,
  retentionScheduleV1,
  destructionNotBefore,
  type LegalHold,
  type RetentionRecordClass,
} from './retention.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));
const tenant = 'northwind-synthetic';
const sha = (fill: string): string => fill.repeat(64 / fill.length);

const acceptedOps = [
  'emit',
  'chain-tamper',
  'audited-operation',
  'export',
  'ai-roundtrip',
  'trail',
  'authority-audit',
  'resolve-clock',
  'not-before',
  'destruction',
  'hold-release',
  'export-expiry',
] as const;
type FixtureOp = (typeof acceptedOps)[number];

interface EmitSpec {
  readonly kind: 'access' | 'ai' | 'disclosure';
  readonly auditId: string;
  readonly occurredAt?: string;
  readonly tenantId?: string;
  readonly subjectRef?: string;
  readonly decision?: 'allow' | 'deny';
  readonly reason?: string;
  readonly partitionTags?: readonly string[];
  readonly detail?: Readonly<Record<string, string>>;
  readonly drop?: readonly string[];
}

interface FixtureCase {
  readonly name: string;
  readonly op: FixtureOp;
  readonly expectError?: string;
  readonly input?: EmitSpec;
  readonly operationCrash?: boolean;
  readonly retry?: boolean;
  readonly sequence?: readonly EmitSpec[];
  readonly tamper?: { readonly auditId: string; readonly field: string; readonly value: string };
  readonly removeAuditId?: string;
  readonly expectBreakReason?: string;
  readonly expectBreakSeq?: number;
  readonly expectValid?: boolean;
  readonly expectChains?: number;
  readonly exportSubjectRef?: string;
  readonly expectRecordIds?: readonly string[];
  readonly expectPartitionTags?: readonly string[];
  readonly subjectRef?: string;
  readonly expectAuditIds?: readonly string[];
  readonly expectModelVersion?: string;
  readonly allowed?: boolean;
  readonly expectDecision?: 'allow' | 'deny';
  readonly recordClass?: string;
  readonly providerState?: string | null;
  readonly patientState?: string | null;
  readonly minor?: boolean;
  readonly expectYears?: number;
  readonly expectAnchor?: string;
  readonly expectDefaultsApplied?: boolean;
  readonly recordDate?: string;
  readonly birthDate?: string;
  readonly expectNotBefore?: string;
  readonly expectMinorExtended?: boolean;
  readonly asOf?: string;
  readonly holdAtEvaluation?: boolean;
  readonly holdAtExecution?: boolean;
  readonly holdRecordClasses?: readonly string[];
  readonly releaseExecutionHold?: boolean;
  readonly expectOutcome?: string;
  readonly expectHoldRefs?: readonly string[];
  readonly expectManifestHash?: boolean;
  readonly holdStatus?: 'active' | 'released';
  readonly evidenceRef?: string;
  readonly expectStatus?: string;
  readonly expiresOn?: string;
  readonly expectExpired?: boolean;
  readonly expectSuspended?: boolean;
}

interface AuditFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly cases: readonly FixtureCase[];
}

function buildEmitInput(spec: EmitSpec): AuditEmitInput {
  const base: AuditEmitInput =
    spec.kind === 'ai'
      ? {
          auditId: spec.auditId,
          tenantId: spec.tenantId ?? tenant,
          stream: 'ai-interaction',
          action: 'draft-message',
          actorRef: 'synthetic-staff:fixture-actor',
          occurredAt: spec.occurredAt ?? '2026-03-22T09:00:00Z',
          subjectRef: spec.subjectRef ?? 'np-fx-subject',
          modelRef: 'model-sim:claude-sonnet',
          modelVersion: 'claude-sonnet-5-synthetic',
          promptRef: `minio://synthetic-ai/prompts/${spec.auditId}`,
          promptHash: sha('ab'),
          outputRef: `minio://synthetic-ai/outputs/${spec.auditId}`,
          outputHash: sha('cd'),
          synthetic: true,
        }
      : spec.kind === 'disclosure'
        ? {
            auditId: spec.auditId,
            tenantId: spec.tenantId ?? tenant,
            stream: 'disclosure',
            action: 'records-export',
            actorRef: 'synthetic-staff:fixture-actor',
            occurredAt: spec.occurredAt ?? '2026-03-22T09:00:00Z',
            subjectRef: spec.subjectRef ?? 'np-fx-subject',
            decision: spec.decision ?? 'allow',
            recipientRef: 'synthetic-recipient:fixture-recipient',
            purpose: 'patient-request',
            synthetic: true,
          }
        : {
            auditId: spec.auditId,
            tenantId: spec.tenantId ?? tenant,
            stream: 'access',
            action: 'chart-view',
            actorRef: 'synthetic-staff:fixture-actor',
            occurredAt: spec.occurredAt ?? '2026-03-22T09:00:00Z',
            subjectRef: spec.subjectRef ?? 'np-fx-subject',
            decision: spec.decision ?? 'allow',
            reason: (spec.reason ?? 'treatment') as NonNullable<AuditEmitInput['reason']>,
            synthetic: true,
          };
  const merged: Record<string, unknown> = { ...base };
  if (spec.partitionTags !== undefined) {
    merged['partitionTags'] = spec.partitionTags;
  }
  if (spec.detail !== undefined) {
    merged['detail'] = spec.detail;
  }
  if (spec.reason !== undefined) {
    merged['reason'] = spec.reason;
  }
  const dropped = new Set(spec.drop ?? []);
  return Object.fromEntries(
    Object.entries(merged).filter(([key]) => !dropped.has(key)),
  ) as unknown as AuditEmitInput;
}

function emitSequence(specs: readonly EmitSpec[]): {
  state: AuditChainState;
  records: AuditRecord[];
} {
  let state: AuditChainState = emptyChainState;
  const records: AuditRecord[] = [];
  for (const spec of specs) {
    const emitted = emitAuditEvent(state, buildEmitInput(spec));
    state = emitted.state;
    records.push(emitted.record);
  }
  return { state, records };
}

function fixtureHold(recordClasses: readonly string[], status: 'active' | 'released'): LegalHold {
  return {
    holdId: 'fxh-0001',
    tenantId: tenant,
    matterRef: 'synthetic-matter-fixture',
    recordClasses: recordClasses as readonly RetentionRecordClass[],
    status,
    placedBy: 'synthetic-staff:fixture-compliance',
    placedBasisRef: 'synthetic-hold-order-fixture',
    ...(status === 'released'
      ? {
          releasedBy: 'synthetic-staff:fixture-compliance',
          releaseEvidenceRef: 'synthetic-release-memo-fixture',
        }
      : {}),
    synthetic: true,
  };
}

function clockFromCase(fixtureCase: FixtureCase): ReturnType<typeof resolveRetentionClock> {
  return resolveRetentionClock(
    jurisdictionPacksV1,
    retentionScheduleV1,
    (fixtureCase.recordClass ?? 'clinical-record') as RetentionRecordClass,
    {
      providerState: fixtureCase.providerState ?? null,
      patientState: fixtureCase.patientState ?? null,
    },
    { minor: fixtureCase.minor ?? false },
  );
}

function runCase(fixtureCase: FixtureCase): void {
  const wrapped = (invoke: () => unknown): unknown => {
    if (fixtureCase.expectError !== undefined) {
      expect(invoke).toThrow(fixtureCase.expectError);
      return undefined;
    }
    return invoke();
  };
  switch (fixtureCase.op) {
    case 'emit': {
      const record = wrapped(
        () => emitAuditEvent(emptyChainState, buildEmitInput(fixtureCase.input as EmitSpec)).record,
      ) as AuditRecord | undefined;
      if (record) {
        expect(record.chainSeq).toBe(1);
        expect(record.entryHash).toMatch(/^[0-9a-f]{64}$/);
        if (fixtureCase.expectDecision !== undefined) {
          expect(record.decision).toBe(fixtureCase.expectDecision);
        }
      }
      break;
    }
    case 'chain-tamper': {
      const { records } = emitSequence(fixtureCase.sequence ?? []);
      let mutated: AuditRecord[] = records;
      if (fixtureCase.tamper !== undefined) {
        const { auditId, field, value } = fixtureCase.tamper;
        mutated = records.map((record) =>
          record.auditId === auditId ? ({ ...record, [field]: value } as AuditRecord) : record,
        );
      }
      if (fixtureCase.removeAuditId !== undefined) {
        mutated = mutated.filter((record) => record.auditId !== fixtureCase.removeAuditId);
      }
      const verification = verifyAuditChain(mutated);
      if (fixtureCase.expectValid !== undefined) {
        expect(verification.valid).toBe(fixtureCase.expectValid);
      }
      if (fixtureCase.expectChains !== undefined) {
        expect(verification.chains).toBe(fixtureCase.expectChains);
      }
      if (fixtureCase.expectBreakReason !== undefined) {
        expect(verification.breaks[0]?.reason).toBe(fixtureCase.expectBreakReason);
      }
      if (fixtureCase.expectBreakSeq !== undefined) {
        expect(verification.breaks[0]?.chainSeq).toBe(fixtureCase.expectBreakSeq);
      }
      break;
    }
    case 'audited-operation': {
      let ran = false;
      const invoke = (): unknown =>
        runAuditedOperation(emptyChainState, buildEmitInput(fixtureCase.input as EmitSpec), () => {
          ran = true;
          if (fixtureCase.operationCrash) {
            throw new Error('synthetic operation crash');
          }
          return 'op-result';
        });
      if (fixtureCase.operationCrash) {
        expect(invoke).toThrow('synthetic operation crash');
        if (fixtureCase.retry) {
          const retried = runAuditedOperation(
            emptyChainState,
            buildEmitInput(fixtureCase.input as EmitSpec),
            () => 'op-result',
          );
          expect(retried.record.chainSeq).toBe(1);
          expect(verifyAuditChain([retried.record]).valid).toBe(true);
        }
        break;
      }
      const outcome = wrapped(invoke) as ReturnType<typeof runAuditedOperation<string>> | undefined;
      if (outcome) {
        expect(outcome.result).toBe('op-result');
        expect(verifyAuditChain([outcome.record]).valid).toBe(true);
      } else {
        // An unauditable operation must never have run — fail closed.
        expect(ran).toBe(false);
      }
      break;
    }
    case 'export': {
      const { state, records } = emitSequence(fixtureCase.sequence ?? []);
      const slice = exportAuditSlice(records, {
        exportAuditId: 'fx-export-0001',
        tenantId: tenant,
        requestedBy: 'synthetic-staff:fixture-compliance',
        recipientRef: 'synthetic-recipient:fixture-auditor',
        purpose: 'investigation',
        occurredAt: '2026-03-22T12:00:00Z',
        ...(fixtureCase.exportSubjectRef !== undefined
          ? { subjectRef: fixtureCase.exportSubjectRef }
          : {}),
      });
      if (fixtureCase.expectRecordIds !== undefined) {
        expect(slice.records.map((record) => record.auditId)).toEqual(fixtureCase.expectRecordIds);
      }
      if (fixtureCase.expectPartitionTags !== undefined) {
        expect(slice.partitionTags).toEqual(fixtureCase.expectPartitionTags);
        expect(slice.exportAuditInput.partitionTags ?? []).toEqual(fixtureCase.expectPartitionTags);
      }
      expect(slice.chainHeads.length).toBeGreaterThan(0);
      // The export itself is audited and chains cleanly.
      const emitted = emitAuditEvent(state, slice.exportAuditInput);
      expect(verifyAuditChain([...records, emitted.record]).valid).toBe(true);
      break;
    }
    case 'ai-roundtrip': {
      const { records } = emitSequence(fixtureCase.sequence ?? []);
      const rows = reconstructAiInteractions(
        records,
        tenant,
        fixtureCase.subjectRef ?? 'np-fx-subject',
      );
      if (fixtureCase.expectAuditIds !== undefined) {
        expect(rows.map((row) => row.auditId)).toEqual(fixtureCase.expectAuditIds);
      }
      for (const row of rows) {
        expect(row.modelVersion).toBe(
          fixtureCase.expectModelVersion ?? 'claude-sonnet-5-synthetic',
        );
        expect(row.promptHash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.outputHash).toMatch(/^[0-9a-f]{64}$/);
      }
      break;
    }
    case 'trail': {
      const { records } = emitSequence(fixtureCase.sequence ?? []);
      const trail = auditTrailForSubject(
        records,
        tenant,
        fixtureCase.subjectRef ?? 'np-fx-subject',
      );
      expect(trail.map((record) => record.auditId)).toEqual(fixtureCase.expectAuditIds ?? []);
      break;
    }
    case 'authority-audit': {
      const decision: AuthorityDecision = {
        capabilityId: 'platform.audit-store',
        tenantId: tenant,
        grantState: fixtureCase.allowed ? 'simulated' : 'scaffolded',
        grantScope: {},
        grantScopeKey: '{}',
        sinceEventId: null,
        allowed: fixtureCase.allowed ?? false,
        reason: 'synthetic fixture decision',
        minimumState: 'simulated',
        checkpoint: 'drain',
      };
      const input = auditInputForAuthorityDecision(decision, {
        auditId: 'fx-authority-0001',
        actorRef: 'synthetic-staff:fixture-actor',
        occurredAt: '2026-03-22T09:00:00Z',
      });
      const emitted = emitAuditEvent(emptyChainState, input);
      expect(emitted.record.decision).toBe(fixtureCase.expectDecision);
      expect(emitted.record.detail?.['capability_id']).toBe('platform.audit-store');
      break;
    }
    case 'resolve-clock': {
      const clock = wrapped(() => clockFromCase(fixtureCase)) as
        ReturnType<typeof resolveRetentionClock> | undefined;
      if (clock) {
        if (fixtureCase.expectYears !== undefined) {
          expect(clock.clockYears).toBe(fixtureCase.expectYears);
        }
        if (fixtureCase.expectAnchor !== undefined) {
          expect(clock.anchor).toBe(fixtureCase.expectAnchor);
        }
        if (fixtureCase.expectDefaultsApplied !== undefined) {
          expect(clock.defaultsApplied).toBe(fixtureCase.expectDefaultsApplied);
        }
      }
      break;
    }
    case 'not-before': {
      const clock = clockFromCase(fixtureCase);
      const window = wrapped(() =>
        destructionNotBefore(clock, {
          recordDate: fixtureCase.recordDate ?? '2020-06-01',
          ...(fixtureCase.birthDate !== undefined
            ? { subjectBirthDate: fixtureCase.birthDate }
            : {}),
        }),
      ) as ReturnType<typeof destructionNotBefore> | undefined;
      if (window) {
        if (fixtureCase.expectNotBefore !== undefined) {
          expect(window.notBefore).toBe(fixtureCase.expectNotBefore);
        }
        if (fixtureCase.expectMinorExtended !== undefined) {
          expect(window.minorExtended).toBe(fixtureCase.expectMinorExtended);
        }
      }
      break;
    }
    case 'destruction': {
      const clock = clockFromCase(fixtureCase);
      const candidate = {
        tenantId: tenant,
        recordClass: (fixtureCase.recordClass ?? 'clinical-record') as RetentionRecordClass,
        recordRefs: ['synthetic-record:fx-0001'],
        recordDate: fixtureCase.recordDate ?? '2020-06-01',
        ...(fixtureCase.birthDate !== undefined ? { subjectBirthDate: fixtureCase.birthDate } : {}),
      };
      const holdsAtEvaluation = fixtureCase.holdAtEvaluation
        ? [fixtureHold(fixtureCase.holdRecordClasses ?? [], 'active')]
        : [];
      const eligibility = evaluateDestructionEligibility(
        clock,
        candidate,
        holdsAtEvaluation,
        fixtureCase.asOf ?? '2026-03-22',
      );
      let holdsAtExecution = fixtureCase.holdAtExecution
        ? [fixtureHold(fixtureCase.holdRecordClasses ?? [], 'active')]
        : [];
      if (fixtureCase.releaseExecutionHold) {
        holdsAtExecution = holdsAtExecution.map(
          (hold) =>
            releaseLegalHold(hold, {
              releasedBy: 'synthetic-staff:fixture-compliance',
              releaseEvidenceRef: 'synthetic-release-memo-fixture',
              auditId: 'fx-hold-release-0001',
              occurredAt: '2026-03-22T10:00:00Z',
            }).hold,
        );
      }
      const outcome = executeDestruction(eligibility, holdsAtExecution, {
        destructionId: 'fx-destruction-0001',
        auditId: 'fx-destruction-audit-0001',
        authorityRef: 'synthetic-staff:fixture-compliance',
        executedBy: 'synthetic-staff:fixture-compliance',
        occurredAt: '2026-03-22T12:00:00Z',
      });
      expect(outcome.outcome).toBe(fixtureCase.expectOutcome);
      if (outcome.outcome === 'suspended-by-hold' && fixtureCase.expectHoldRefs !== undefined) {
        expect(outcome.holdRefs).toEqual(fixtureCase.expectHoldRefs);
      }
      if (outcome.outcome === 'destroyed' && fixtureCase.expectManifestHash) {
        expect(outcome.evidence.manifestHash).toMatch(/^[0-9a-f]{64}$/);
        expect(outcome.evidence.whyBasisRefs.length).toBeGreaterThan(0);
        expect(outcome.evidence.authorityRef).toBe('synthetic-staff:fixture-compliance');
        expect(emitAuditEvent(emptyChainState, outcome.auditInput).record.entryHash).toMatch(
          /^[0-9a-f]{64}$/,
        );
      }
      break;
    }
    case 'hold-release': {
      const hold = fixtureHold([], fixtureCase.holdStatus ?? 'active');
      const outcome = wrapped(() =>
        releaseLegalHold(hold, {
          releasedBy: 'synthetic-staff:fixture-compliance',
          releaseEvidenceRef: fixtureCase.evidenceRef ?? 'synthetic-release-memo-fixture',
          auditId: 'fx-hold-release-0002',
          occurredAt: '2026-03-22T10:00:00Z',
        }),
      ) as ReturnType<typeof releaseLegalHold> | undefined;
      if (outcome && fixtureCase.expectStatus !== undefined) {
        expect(outcome.hold.status).toBe(fixtureCase.expectStatus);
        expect(emitAuditEvent(emptyChainState, outcome.auditInput).record.action).toBe(
          'legal-hold-released',
        );
      }
      break;
    }
    case 'export-expiry': {
      const holds = fixtureCase.holdAtEvaluation
        ? [fixtureHold(fixtureCase.holdRecordClasses ?? [], 'active')]
        : [];
      const evaluation = evaluateExportExpiry(
        {
          tenantId: tenant,
          recordClass: (fixtureCase.recordClass ?? 'clinical-record') as RetentionRecordClass,
          expiresOn: fixtureCase.expiresOn ?? '2026-01-01',
        },
        holds,
        fixtureCase.asOf ?? '2026-03-22',
      );
      expect(evaluation.expired).toBe(fixtureCase.expectExpired);
      if (fixtureCase.expectSuspended !== undefined) {
        expect(evaluation.suspendedByHoldRefs.length > 0).toBe(fixtureCase.expectSuspended);
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

for (const requirementId of ['R6-REQ-001', 'R6-REQ-102', 'R6-REQ-052', 'R6-SR-080']) {
  describe(`${requirementId} fixture pack (4-class floor)`, () => {
    const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);

    it('carries all four fixture classes with the synthetic watermark', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
    });

    it('every case declares a recognized op (load-time validation, review-009)', () => {
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as unknown as AuditFixture;
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
        const fixture = pack.fixtures[fixtureClass] as unknown as AuditFixture;
        for (const fixtureCase of fixture.cases) {
          it(fixtureCase.name, () => {
            runCase(fixtureCase);
          });
        }
      });
    }
  });
}
