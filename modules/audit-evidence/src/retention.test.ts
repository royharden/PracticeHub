/**
 * Unit suite for the retention engine + legal hold (WP-020 gate surface:
 * R6-SR-080 per-state clocks + purge-vs-hold race; R6-REQ-052 retention
 * slice). The medical-record clock is pinned to the WP-011 jurisdiction rule
 * packs — one source of truth, drift named here if either side moves.
 */
import { jurisdictionPacksV1 } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { validateAuditEmitInput } from './audit.js';
import {
  addYears,
  assertRetentionScheduleWellFormed,
  destructionManifestHash,
  destructionNotBefore,
  evaluateDestructionEligibility,
  evaluateExportExpiry,
  executeDestruction,
  holdApplies,
  releaseLegalHold,
  resolveRetentionClock,
  retentionScheduleV1,
  type DestructionCandidate,
  type LegalHold,
  type RetentionClock,
  type RetentionRecordClass,
} from './retention.js';

const packs = jurisdictionPacksV1;
const tenant = 'northwind-synthetic';

const activeHold: LegalHold = {
  holdId: 'th-0001',
  tenantId: tenant,
  matterRef: 'synthetic-matter-test',
  recordClasses: ['clinical-record'],
  status: 'active',
  placedBy: 'synthetic-staff:compliance-001',
  placedBasisRef: 'synthetic-hold-order-test',
  synthetic: true,
};

const adult = { minor: false };

function clockFor(recordClass: RetentionRecordClass): RetentionClock {
  return resolveRetentionClock(
    packs,
    retentionScheduleV1,
    recordClass,
    { providerState: 'NV', patientState: 'NV' },
    adult,
  );
}

describe('retention schedule data of record', () => {
  it('is well-formed and covers every record class', () => {
    expect(() => assertRetentionScheduleWellFormed(retentionScheduleV1)).not.toThrow();
  });

  it('a schedule missing a class is refused — an unscheduled class cannot resolve', () => {
    const truncated = {
      ...retentionScheduleV1,
      entries: retentionScheduleV1.entries.filter((entry) => entry.recordClass !== 'gfe-record'),
    };
    expect(() => assertRetentionScheduleWellFormed(truncated)).toThrow('gfe-record');
  });
});

describe('state-clocked classes resolve through the WP-011 packs (one source of truth)', () => {
  it.each([
    ['NV', 5],
    ['FL', 5],
    ['IL', 10],
    ['MN', 7],
  ] as const)('clinical-record in %s resolves the pack clock (%i)', (state, years) => {
    const clock = resolveRetentionClock(
      packs,
      retentionScheduleV1,
      'clinical-record',
      { providerState: state, patientState: state },
      adult,
    );
    expect(clock.clockYears).toBe(years);
    expect(clock.basisRefs).toContain(`retention-pack:${state}:v1`);
    expect(clock.counselReviewPending).toBe(true);
  });

  it('a multi-state basis takes the LONGEST clock (strictest cascade)', () => {
    const clock = resolveRetentionClock(
      packs,
      retentionScheduleV1,
      'clinical-record',
      { providerState: 'NV', patientState: 'IL' },
      adult,
    );
    expect(clock.clockYears).toBe(10);
  });

  it('an unknown governing state fails toward the longest known clock', () => {
    const clock = resolveRetentionClock(
      packs,
      retentionScheduleV1,
      'clinical-record',
      { providerState: 'NV', patientState: null },
      adult,
    );
    expect(clock.clockYears).toBe(10);
    expect(clock.defaultsApplied).toBe(true);
  });

  it('the schedule minimum floors a resolver outcome (consent-artifact: 6 over NV 5)', () => {
    const clock = resolveRetentionClock(
      packs,
      retentionScheduleV1,
      'consent-artifact',
      { providerState: 'NV', patientState: 'NV' },
      adult,
    );
    expect(clock.clockYears).toBe(6);
  });

  it('federal fixed-term classes carry their 6-year floors (R6-REQ-052 for gfe-record)', () => {
    for (const recordClass of [
      'audit-log',
      'ai-interaction',
      'gfe-record',
      'disclosure-accounting',
    ] as const) {
      const clock = clockFor(recordClass);
      expect(clock.clockYears, recordClass).toBe(6);
      expect(clock.defaultsApplied).toBe(false);
    }
  });
});

describe('minors extension (R6-SR-080)', () => {
  it('anchors the clock at the LATER of record date and age-of-majority', () => {
    const clock = resolveRetentionClock(
      packs,
      retentionScheduleV1,
      'clinical-record',
      { providerState: 'NV', patientState: 'NV' },
      { minor: true },
    );
    expect(clock.anchor).toBe('later-of-age-of-majority-or-record-date');
    const window = destructionNotBefore(clock, {
      recordDate: '2020-06-01',
      subjectBirthDate: '2015-03-10',
    });
    // Age of majority 2033-03-10 plus the 5-year clock beats 2025-06-01.
    expect(window.notBefore).toBe('2038-03-10');
    expect(window.minorExtended).toBe(true);
  });

  it('a minor-anchored clock without a birth date fails toward retention', () => {
    const clock = resolveRetentionClock(
      packs,
      retentionScheduleV1,
      'clinical-record',
      { providerState: 'NV', patientState: 'NV' },
      { minor: true },
    );
    expect(() => destructionNotBefore(clock, { recordDate: '2020-06-01' })).toThrow(
      'fails toward retention',
    );
  });

  it('addYears clamps Feb 29 off leap years', () => {
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
    expect(addYears('2024-02-29', 4)).toBe('2028-02-29');
  });
});

describe('destruction eligibility and the purge-vs-hold race', () => {
  const candidate: DestructionCandidate = {
    tenantId: tenant,
    recordClass: 'clinical-record',
    recordRefs: ['synthetic-record:cr-0001', 'synthetic-record:cr-0002'],
    recordDate: '2020-06-01',
  };
  const clock = clockFor('clinical-record');
  const execution = {
    destructionId: 'td-0001',
    auditId: 'tda-0001',
    authorityRef: 'synthetic-staff:compliance-001',
    executedBy: 'synthetic-staff:compliance-001',
    occurredAt: '2026-03-20T12:00:00Z',
  };

  it('a running clock is not eligible and execution refuses it outright', () => {
    const early = evaluateDestructionEligibility(clock, candidate, [], '2024-01-01');
    expect(early.eligible).toBe(false);
    const outcome = executeDestruction(early, [], execution);
    expect(outcome.outcome).toBe('refused-clock-active');
  });

  it('an applicable hold blocks eligibility', () => {
    const held = evaluateDestructionEligibility(clock, candidate, [activeHold], '2026-03-20');
    expect(held.eligible).toBe(false);
    expect(held.holdRefsAtEvaluation).toEqual(['th-0001']);
  });

  it('THE RACE: a hold placed after the eligibility scan suspends execution', () => {
    const eligibility = evaluateDestructionEligibility(clock, candidate, [], '2026-03-20');
    expect(eligibility.eligible).toBe(true);
    const outcome = executeDestruction(eligibility, [activeHold], execution);
    expect(outcome.outcome).toBe('suspended-by-hold');
    if (outcome.outcome === 'suspended-by-hold') {
      expect(outcome.holdRefs).toEqual(['th-0001']);
      expect(() => validateAuditEmitInput(outcome.auditInput)).not.toThrow();
      expect(outcome.auditInput.action).toBe('destruction-suspended-by-hold');
    }
  });

  it('hold scope matters: a released hold or an unrelated class never suspends', () => {
    const released: LegalHold = {
      ...activeHold,
      status: 'released',
      releasedBy: 'synthetic-staff:compliance-001',
      releaseEvidenceRef: 'synthetic-release-memo',
    };
    const otherClass: LegalHold = {
      ...activeHold,
      holdId: 'th-0002',
      recordClasses: ['gfe-record'],
    };
    expect(holdApplies(released, candidate)).toBe(false);
    expect(holdApplies(otherClass, candidate)).toBe(false);
    const eligibility = evaluateDestructionEligibility(clock, candidate, [], '2026-03-20');
    const outcome = executeDestruction(eligibility, [released, otherClass], execution);
    expect(outcome.outcome).toBe('destroyed');
  });

  it('destruction produces evidence: what, why, authority, manifest hash — audited', () => {
    const eligibility = evaluateDestructionEligibility(clock, candidate, [], '2026-03-20');
    const outcome = executeDestruction(eligibility, [], execution);
    expect(outcome.outcome).toBe('destroyed');
    if (outcome.outcome === 'destroyed') {
      expect(outcome.evidence.recordRefs).toEqual(candidate.recordRefs);
      expect(outcome.evidence.whyBasisRefs).toEqual(eligibility.window.basisRefs);
      expect(outcome.evidence.authorityRef).toBe('synthetic-staff:compliance-001');
      expect(outcome.evidence.manifestHash).toBe(destructionManifestHash(candidate.recordRefs));
      expect(() => validateAuditEmitInput(outcome.auditInput)).not.toThrow();
      expect(outcome.auditInput.detail?.['manifest_hash']).toBe(outcome.evidence.manifestHash);
    }
  });
});

describe('legal-hold release governance', () => {
  it('release carries released-by and evidence, and is itself audited', () => {
    const release = releaseLegalHold(activeHold, {
      releasedBy: 'synthetic-staff:compliance-001',
      releaseEvidenceRef: 'synthetic-release-memo-0001',
      auditId: 'thr-0001',
      occurredAt: '2026-03-21T09:00:00Z',
    });
    expect(release.hold.status).toBe('released');
    expect(release.hold.releaseEvidenceRef).toBe('synthetic-release-memo-0001');
    expect(() => validateAuditEmitInput(release.auditInput)).not.toThrow();
    expect(release.auditInput.action).toBe('legal-hold-released');
    expect(release.auditInput.correlationRef).toBe('th-0001');
  });

  it('an unevidenced release, or releasing a released hold, is refused', () => {
    expect(() =>
      releaseLegalHold(activeHold, {
        releasedBy: 'synthetic-staff:compliance-001',
        releaseEvidenceRef: '  ',
        auditId: 'thr-0002',
        occurredAt: '2026-03-21T09:00:00Z',
      }),
    ).toThrow('release evidence');
    const released = releaseLegalHold(activeHold, {
      releasedBy: 'synthetic-staff:compliance-001',
      releaseEvidenceRef: 'synthetic-release-memo-0001',
      auditId: 'thr-0003',
      occurredAt: '2026-03-21T09:00:00Z',
    }).hold;
    expect(() =>
      releaseLegalHold(released, {
        releasedBy: 'synthetic-staff:compliance-001',
        releaseEvidenceRef: 'synthetic-release-memo-0002',
        auditId: 'thr-0004',
        occurredAt: '2026-03-21T09:05:00Z',
      }),
    ).toThrow('not active');
  });

  it('an active hold suspends export-expiry too (contract decision 8)', () => {
    const exportRecord = {
      tenantId: tenant,
      recordClass: 'clinical-record',
      expiresOn: '2026-01-01',
    } as const;
    expect(evaluateExportExpiry(exportRecord, [], '2026-03-20')).toEqual({
      expired: true,
      suspendedByHoldRefs: [],
    });
    expect(evaluateExportExpiry(exportRecord, [activeHold], '2026-03-20')).toEqual({
      expired: false,
      suspendedByHoldRefs: ['th-0001'],
    });
  });
});
