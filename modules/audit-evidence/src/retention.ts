/**
 * Retention engine + legal hold (WP-020, R6-SR-080 + R6-REQ-052 slice).
 * Contract: docs/contracts/audit-emit.md (FROZEN), decisions 7-9.
 *
 * Retention schedules are counsel-owned DATA per record class. Classes whose
 * clock is state law resolve through the WP-011 jurisdiction resolver's
 * `retention` topic — the medical-record clock has exactly ONE source of
 * truth (the jurisdiction rule packs; strictest = longest, unknown facts
 * fail toward the longest known clock). Federal classes carry fixed terms.
 * Legal hold suspends destruction AND export-expiry; destruction produces
 * evidence (what/why/authority/manifest hash). Everything is pure over
 * caller-supplied facts and an explicit `asOf` instant.
 */

import { createHash } from 'node:crypto';

import {
  resolveJurisdiction,
  type JurisdictionBasis,
  type JurisdictionRulePack,
} from '@practicehub/platform-core';

import type { AuditEmitInput } from './audit.js';

export const retentionRecordClasses = [
  'clinical-record',
  'consent-artifact',
  'audit-log',
  'ai-interaction',
  'gfe-record',
  'disclosure-accounting',
] as const;
export type RetentionRecordClass = (typeof retentionRecordClasses)[number];

export type RetentionBasisKind = 'jurisdiction-resolver' | 'fixed-term';
export type MinorsExtension = 'age-of-majority-anchor' | 'none';

export interface RetentionScheduleEntry {
  readonly recordClass: RetentionRecordClass;
  readonly basis: RetentionBasisKind;
  /** Required for fixed-term entries. */
  readonly fixedTermYears?: number;
  /** Floor applied regardless of basis — the clock never resolves below it. */
  readonly minimumYears: number;
  readonly minorsExtension: MinorsExtension;
  /** Age-of-majority anchor input for minors extensions. */
  readonly ageOfMajorityYears: number;
  /** Statutory/source citation (state-matrix row, R6 id, or CFR cite ref). */
  readonly basisRef: string;
}

export interface RetentionSchedule {
  readonly version: number;
  /** Counsel-owned data: draft until sign-off (EW-025 class). */
  readonly status: 'draft' | 'counsel-signed';
  readonly changeControlRef: string;
  readonly entries: readonly RetentionScheduleEntry[];
  readonly synthetic: true;
}

export class RetentionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RetentionError';
  }
}

export function assertRetentionScheduleWellFormed(schedule: RetentionSchedule): void {
  const seen = new Set<string>();
  for (const entry of schedule.entries) {
    if (!(retentionRecordClasses as readonly string[]).includes(entry.recordClass)) {
      throw new RetentionError(`unknown record class ${JSON.stringify(entry.recordClass)}`);
    }
    if (seen.has(entry.recordClass)) {
      throw new RetentionError(`duplicate schedule entry for ${entry.recordClass}`);
    }
    seen.add(entry.recordClass);
    if (entry.basis === 'fixed-term' && (entry.fixedTermYears ?? 0) < 1) {
      throw new RetentionError(`${entry.recordClass}: fixed-term entries require fixedTermYears`);
    }
    if (entry.minimumYears < 1) {
      throw new RetentionError(`${entry.recordClass}: minimumYears must be at least 1`);
    }
    if (entry.ageOfMajorityYears < 18) {
      throw new RetentionError(`${entry.recordClass}: ageOfMajorityYears floors at 18`);
    }
    if (!entry.basisRef.trim()) {
      throw new RetentionError(`${entry.recordClass}: basisRef is required`);
    }
  }
  for (const recordClass of retentionRecordClasses) {
    if (!seen.has(recordClass)) {
      throw new RetentionError(`schedule is missing the ${recordClass} entry`);
    }
  }
}

/**
 * The v1 schedule data of record. `draft` pending counsel sign-off (EW-025
 * class); the generated seed section and the DB registry are projections of
 * this object — never edit those directly.
 */
export const retentionScheduleV1: RetentionSchedule = {
  version: 1,
  status: 'draft',
  changeControlRef: 'wp-020-retention-schedule-v1',
  entries: [
    {
      recordClass: 'clinical-record',
      basis: 'jurisdiction-resolver',
      minimumYears: 5,
      minorsExtension: 'age-of-majority-anchor',
      ageOfMajorityYears: 18,
      basisRef: 'state-matrix-sec-8-r6-sr-080',
    },
    {
      recordClass: 'consent-artifact',
      basis: 'jurisdiction-resolver',
      minimumYears: 6,
      minorsExtension: 'age-of-majority-anchor',
      ageOfMajorityYears: 18,
      basisRef: 'state-matrix-sec-8-consent-follows-record-clock',
    },
    {
      recordClass: 'audit-log',
      basis: 'fixed-term',
      fixedTermYears: 6,
      minimumYears: 6,
      minorsExtension: 'none',
      ageOfMajorityYears: 18,
      basisRef: 'hipaa-45-cfr-164-316-b-2-documentation',
    },
    {
      recordClass: 'ai-interaction',
      basis: 'fixed-term',
      fixedTermYears: 6,
      minimumYears: 6,
      minorsExtension: 'none',
      ageOfMajorityYears: 18,
      basisRef: 'r6-req-102-ai-log-follows-audit-log-clock',
    },
    {
      recordClass: 'gfe-record',
      basis: 'fixed-term',
      fixedTermYears: 6,
      minimumYears: 6,
      minorsExtension: 'none',
      ageOfMajorityYears: 18,
      basisRef: 'r6-req-052-nsa-gfe-45-cfr-149-610',
    },
    {
      recordClass: 'disclosure-accounting',
      basis: 'fixed-term',
      fixedTermYears: 6,
      minimumYears: 6,
      minorsExtension: 'none',
      ageOfMajorityYears: 18,
      basisRef: 'hipaa-45-cfr-164-528-accounting',
    },
  ],
  synthetic: true,
};

export interface RetentionClock {
  readonly recordClass: RetentionRecordClass;
  readonly clockYears: number;
  readonly anchor: 'record-date' | 'later-of-age-of-majority-or-record-date';
  readonly ageOfMajorityYears: number;
  readonly basisRefs: readonly string[];
  readonly defaultsApplied: boolean;
  readonly counselReviewPending: boolean;
}

export interface RetentionSubject {
  readonly minor: boolean;
}

const retentionScalarKey = 'retention-years-adult';

/**
 * Resolve one record's retention clock (R6-SR-080). Resolver-based classes
 * take the WP-011 `retention` topic resolution over the record's governing
 * basis (provider fact x patient fact x floor; strictest = longest; unknown
 * facts contribute the safe-default pack's longest clock). The schedule
 * minimum floors every outcome. Minors on anchored classes release no
 * earlier than age-of-majority plus the clock.
 */
export function resolveRetentionClock(
  packs: readonly JurisdictionRulePack[],
  schedule: RetentionSchedule,
  recordClass: RetentionRecordClass,
  basis: JurisdictionBasis,
  subject: RetentionSubject,
): RetentionClock {
  assertRetentionScheduleWellFormed(schedule);
  const entry = schedule.entries.find((candidate) => candidate.recordClass === recordClass);
  if (entry === undefined) {
    throw new RetentionError(`no schedule entry for ${recordClass} — destruction is refused`);
  }
  const basisRefs: string[] = [entry.basisRef];
  let clockYears: number;
  let defaultsApplied = false;
  let counselReviewPending = schedule.status !== 'counsel-signed';
  if (entry.basis === 'jurisdiction-resolver') {
    const resolution = resolveJurisdiction(packs, basis, 'retention');
    const resolved = resolution.scalars[retentionScalarKey];
    if (resolved === undefined) {
      throw new RetentionError(
        `retention resolution carries no ${retentionScalarKey} scalar — refusing a clockless class`,
      );
    }
    clockYears = Math.max(resolved, entry.minimumYears);
    defaultsApplied = resolution.defaultsApplied;
    counselReviewPending = counselReviewPending || resolution.counselReviewPending;
    for (const contribution of resolution.contributions) {
      if (contribution.scalars[retentionScalarKey] !== undefined) {
        const ref = `retention-pack:${contribution.jurisdiction}:v${contribution.packVersion}`;
        if (!basisRefs.includes(ref)) {
          basisRefs.push(ref);
        }
      }
    }
  } else {
    clockYears = Math.max(entry.fixedTermYears ?? 0, entry.minimumYears);
  }
  const anchored = subject.minor && entry.minorsExtension === 'age-of-majority-anchor';
  return {
    recordClass,
    clockYears,
    anchor: anchored ? 'later-of-age-of-majority-or-record-date' : 'record-date',
    ageOfMajorityYears: entry.ageOfMajorityYears,
    basisRefs,
    defaultsApplied,
    counselReviewPending,
  };
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string, label: string): void {
  if (!isoDatePattern.test(value)) {
    throw new RetentionError(`${label} must be an ISO date (YYYY-MM-DD)`);
  }
}

/** Add whole years to an ISO date; Feb 29 clamps to Feb 28 off leap years. */
export function addYears(isoDate: string, years: number): string {
  assertIsoDate(isoDate, 'date');
  const year = Number(isoDate.slice(0, 4)) + years;
  const monthDay = isoDate.slice(5);
  if (monthDay === '02-29' && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) {
    return `${String(year).padStart(4, '0')}-02-28`;
  }
  return `${String(year).padStart(4, '0')}-${monthDay}`;
}

export interface DestructionWindow {
  /** No destruction earlier than this date, on any path. */
  readonly notBefore: string;
  readonly basisRefs: readonly string[];
  readonly minorExtended: boolean;
}

/** The earliest lawful destruction date for one record under its clock. */
export function destructionNotBefore(
  clock: RetentionClock,
  record: { readonly recordDate: string; readonly subjectBirthDate?: string },
): DestructionWindow {
  assertIsoDate(record.recordDate, 'recordDate');
  const fromRecord = addYears(record.recordDate, clock.clockYears);
  if (clock.anchor === 'record-date') {
    return { notBefore: fromRecord, basisRefs: clock.basisRefs, minorExtended: false };
  }
  if (record.subjectBirthDate === undefined) {
    throw new RetentionError(
      'a minor-anchored clock requires subjectBirthDate — an unknown anchor fails toward retention',
    );
  }
  assertIsoDate(record.subjectBirthDate, 'subjectBirthDate');
  const fromMajority = addYears(
    addYears(record.subjectBirthDate, clock.ageOfMajorityYears),
    clock.clockYears,
  );
  const notBefore = fromMajority > fromRecord ? fromMajority : fromRecord;
  return { notBefore, basisRefs: clock.basisRefs, minorExtended: notBefore === fromMajority };
}

export interface LegalHold {
  readonly holdId: string;
  readonly tenantId: string;
  readonly matterRef: string;
  /** Absent = the whole tenant. */
  readonly legalEntityId?: string;
  /** Empty = every record class. */
  readonly recordClasses: readonly RetentionRecordClass[];
  readonly status: 'active' | 'released';
  readonly placedBy: string;
  readonly placedBasisRef: string;
  readonly releasedBy?: string;
  readonly releaseEvidenceRef?: string;
  readonly synthetic: true;
}

export function holdApplies(
  hold: LegalHold,
  target: {
    readonly tenantId: string;
    readonly recordClass: RetentionRecordClass;
    readonly legalEntityId?: string;
  },
): boolean {
  return (
    hold.status === 'active' &&
    hold.tenantId === target.tenantId &&
    (hold.legalEntityId === undefined || hold.legalEntityId === target.legalEntityId) &&
    (hold.recordClasses.length === 0 || hold.recordClasses.includes(target.recordClass))
  );
}

/**
 * Release requires attribution + evidence and is itself audited (contract
 * decision 8). Holds never delete; they release.
 */
export function releaseLegalHold(
  hold: LegalHold,
  release: {
    readonly releasedBy: string;
    readonly releaseEvidenceRef: string;
    readonly auditId: string;
    readonly occurredAt: string;
  },
): { readonly hold: LegalHold; readonly auditInput: AuditEmitInput } {
  if (hold.status !== 'active') {
    throw new RetentionError(`hold ${hold.holdId} is not active`);
  }
  if (!release.releasedBy.trim() || !release.releaseEvidenceRef.trim()) {
    throw new RetentionError('a hold release carries released-by and release evidence, always');
  }
  const released: LegalHold = {
    ...hold,
    status: 'released',
    releasedBy: release.releasedBy,
    releaseEvidenceRef: release.releaseEvidenceRef,
  };
  return {
    hold: released,
    auditInput: {
      auditId: release.auditId,
      tenantId: hold.tenantId,
      stream: 'config-change',
      action: 'legal-hold-released',
      actorRef: release.releasedBy,
      occurredAt: release.occurredAt,
      correlationRef: hold.holdId,
      detail: {
        config_ref: `legal-hold:${hold.holdId}`,
        matter_ref: hold.matterRef,
        release_evidence_ref: release.releaseEvidenceRef,
      },
      synthetic: true,
    },
  };
}

export interface DestructionCandidate {
  readonly tenantId: string;
  readonly recordClass: RetentionRecordClass;
  readonly recordRefs: readonly string[];
  readonly recordDate: string;
  readonly subjectBirthDate?: string;
  readonly legalEntityId?: string;
}

export interface DestructionEligibility {
  readonly candidate: DestructionCandidate;
  readonly window: DestructionWindow;
  readonly eligible: boolean;
  readonly asOf: string;
  /** Holds applicable at EVALUATION — execution re-checks its own list. */
  readonly holdRefsAtEvaluation: readonly string[];
}

/** Eligibility scan: clock expired AND no applicable hold at evaluation. */
export function evaluateDestructionEligibility(
  clock: RetentionClock,
  candidate: DestructionCandidate,
  holds: readonly LegalHold[],
  asOf: string,
): DestructionEligibility {
  assertIsoDate(asOf, 'asOf');
  if (clock.recordClass !== candidate.recordClass) {
    throw new RetentionError(
      `clock is for ${clock.recordClass} but the candidate is ${candidate.recordClass}`,
    );
  }
  const window = destructionNotBefore(clock, candidate);
  const applicable = holds.filter((hold) => holdApplies(hold, candidate));
  return {
    candidate,
    window,
    eligible: asOf >= window.notBefore && applicable.length === 0,
    asOf,
    holdRefsAtEvaluation: applicable.map((hold) => hold.holdId),
  };
}

export interface DestructionEvidence {
  readonly destructionId: string;
  readonly tenantId: string;
  readonly recordClass: RetentionRecordClass;
  /** WHAT was destroyed. */
  readonly recordRefs: readonly string[];
  /** WHY — the schedule basis refs behind the expired clock. */
  readonly whyBasisRefs: readonly string[];
  /** WHO authorized. */
  readonly authorityRef: string;
  /** sha-256 over the canonical manifest of destroyed refs. */
  readonly manifestHash: string;
  readonly auditId: string;
  readonly synthetic: true;
}

export type DestructionOutcome =
  | {
      readonly outcome: 'destroyed';
      readonly evidence: DestructionEvidence;
      readonly auditInput: AuditEmitInput;
    }
  | {
      readonly outcome: 'suspended-by-hold';
      readonly holdRefs: readonly string[];
      readonly auditInput: AuditEmitInput;
    }
  | { readonly outcome: 'refused-clock-active'; readonly notBefore: string };

export function destructionManifestHash(recordRefs: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...recordRefs].sort()))
    .digest('hex');
}

/**
 * Execute a destruction. THE RACE RESOLVES TO THE HOLD: execution re-checks
 * the holds it is handed at execution — a hold placed after the eligibility
 * scan suspends the destruction (R6-SR-080 legal-hold-override), and the
 * suspension is itself audited. A still-running clock refuses outright.
 * Success produces append-only evidence: what, why, authority, manifest hash
 * (ADR-008 Decision 4).
 */
export function executeDestruction(
  eligibility: DestructionEligibility,
  holdsAtExecution: readonly LegalHold[],
  execution: {
    readonly destructionId: string;
    readonly auditId: string;
    readonly authorityRef: string;
    readonly executedBy: string;
    readonly occurredAt: string;
  },
): DestructionOutcome {
  const { candidate, window } = eligibility;
  if (eligibility.asOf < window.notBefore) {
    return { outcome: 'refused-clock-active', notBefore: window.notBefore };
  }
  const applicable = holdsAtExecution.filter((hold) => holdApplies(hold, candidate));
  if (applicable.length > 0) {
    return {
      outcome: 'suspended-by-hold',
      holdRefs: applicable.map((hold) => hold.holdId),
      auditInput: {
        auditId: execution.auditId,
        tenantId: candidate.tenantId,
        stream: 'config-change',
        action: 'destruction-suspended-by-hold',
        actorRef: execution.executedBy,
        occurredAt: execution.occurredAt,
        correlationRef: execution.destructionId,
        detail: {
          config_ref: `destruction:${execution.destructionId}`,
          record_class: candidate.recordClass,
          hold_refs: applicable.map((hold) => hold.holdId).join(','),
        },
        synthetic: true,
      },
    };
  }
  const manifestHash = destructionManifestHash(candidate.recordRefs);
  const evidence: DestructionEvidence = {
    destructionId: execution.destructionId,
    tenantId: candidate.tenantId,
    recordClass: candidate.recordClass,
    recordRefs: candidate.recordRefs,
    whyBasisRefs: window.basisRefs,
    authorityRef: execution.authorityRef,
    manifestHash,
    auditId: execution.auditId,
    synthetic: true,
  };
  return {
    outcome: 'destroyed',
    evidence,
    auditInput: {
      auditId: execution.auditId,
      tenantId: candidate.tenantId,
      stream: 'config-change',
      action: 'destruction-executed',
      actorRef: execution.executedBy,
      occurredAt: execution.occurredAt,
      correlationRef: execution.destructionId,
      detail: {
        config_ref: `destruction:${execution.destructionId}`,
        record_class: candidate.recordClass,
        manifest_hash: manifestHash,
        authority_ref: execution.authorityRef,
      },
      synthetic: true,
    },
  };
}

/**
 * Export-expiry suspension (contract decision 8): a governed export past its
 * expiry is purgeable ONLY while no applicable hold is active.
 */
export function evaluateExportExpiry(
  exportRecord: {
    readonly tenantId: string;
    readonly recordClass: RetentionRecordClass;
    readonly expiresOn: string;
    readonly legalEntityId?: string;
  },
  holds: readonly LegalHold[],
  asOf: string,
): { readonly expired: boolean; readonly suspendedByHoldRefs: readonly string[] } {
  assertIsoDate(asOf, 'asOf');
  assertIsoDate(exportRecord.expiresOn, 'expiresOn');
  const applicable = holds.filter((hold) => holdApplies(hold, exportRecord));
  return {
    expired: asOf >= exportRecord.expiresOn && applicable.length === 0,
    suspendedByHoldRefs: applicable.map((hold) => hold.holdId),
  };
}
