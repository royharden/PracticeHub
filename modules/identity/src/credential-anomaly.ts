/**
 * Credential + access anomaly detection (WP-017, M02). Contract:
 * docs/contracts/elevation-api.md (FROZEN). Requirements: REQ-ID-002
 * (credential-sharing and concurrent-session anomaly review), REQ-ADM-019
 * (access-anomaly detection flags a snooping pattern and opens an
 * investigation). Executes FWD-AUTH-017-ANOMALY (session.ts): the detection
 * HEURISTICS live here and feed the WP-014 `raiseAtoLockdown` signal set.
 *
 * Two failure modes, two surfaces:
 *  - Session anomalies (credential-sharing / concurrent-session / impossible
 *    travel) → `AtoSignal[]` (the WP-014 ato.ts type) that drive
 *    `raiseAtoLockdown` — the containment path.
 *  - Snooping access (a workforce member reaching records with no treatment
 *    relationship AND outside their assignment) → an investigation CASE with
 *    the signals recorded VERBATIM (forensic), plus an investigation WorkItem.
 * Anomaly detection is detective/protective and is deliberately NOT
 * capability-gated (WP-012 lesson).
 */

import type { PersonId, TenantId } from '@practicehub/contracts';

import type { AtoSignal } from './ato.js';
import {
  ElevationError,
  assertId,
  assertInstant,
  assertRef,
  configChangeAuditInput,
  type AuthorityReviewWorkItem,
  type ElevationConfigAuditInput,
} from './elevation-shared.js';

/* --------------------------------------------------------------- *
 * Session anomalies → AtoSignal[] (FWD-AUTH-017-ANOMALY)           *
 * --------------------------------------------------------------- */

/** One authenticated-session sighting for the same account. */
export interface SessionSighting {
  readonly sessionId: string;
  readonly deviceId: string;
  /** Coarse location ref (region/asn); NEVER a raw address — grammar-clean. */
  readonly locationRef: string;
  readonly observedAt: string;
}

export interface SessionAnomalyThresholds {
  /** Distinct concurrent devices for one account that raise a concurrent-session signal. */
  readonly concurrentDeviceThreshold: number;
  /** Distinct locations for one account inside the window that raise credential-sharing. */
  readonly distinctLocationThreshold: number;
}

/** A conservative default; the WP-014 `tuneAtoThresholds` floor still governs downstream. */
export const sessionAnomalyThresholdsV1: SessionAnomalyThresholds = {
  concurrentDeviceThreshold: 3,
  distinctLocationThreshold: 2,
};

/**
 * Detect session-level anomalies for one account's sightings and emit the
 * WP-014 `AtoSignal`s that feed `raiseAtoLockdown` (REQ-ID-002; the
 * containment/lockdown machinery is WP-014). Concurrent distinct devices at or
 * above the threshold → `new-device-burst`; distinct locations at or above the
 * threshold inside the window → `credential-stuffing` (credential sharing);
 * two sightings whose locations differ within a very tight window →
 * `impossible-travel`. Deterministic and order-independent.
 */
export function detectSessionAnomalies(
  sightings: readonly SessionSighting[],
  thresholds: SessionAnomalyThresholds = sessionAnomalyThresholdsV1,
): readonly AtoSignal[] {
  if (sightings.length === 0) {
    return [];
  }
  for (const sighting of sightings) {
    assertInstant(sighting.observedAt, 'observedAt');
  }
  const signals: AtoSignal[] = [];
  const devices = new Set(sightings.map((sighting) => sighting.deviceId));
  const locations = new Set(sightings.map((sighting) => sighting.locationRef));
  const latest = sightings.reduce((max, sighting) =>
    Date.parse(sighting.observedAt) >= Date.parse(max.observedAt) ? sighting : max,
  );

  if (devices.size >= thresholds.concurrentDeviceThreshold) {
    signals.push({
      kind: 'new-device-burst',
      detail: `concurrent-devices:${devices.size}`,
      observedAt: latest.observedAt,
    });
  }
  if (locations.size >= thresholds.distinctLocationThreshold) {
    signals.push({
      kind: 'credential-stuffing',
      detail: `credential-sharing:${locations.size}-locations`,
      observedAt: latest.observedAt,
    });
  }
  // Impossible travel: two sightings at different locations within five minutes.
  const sorted = [...sightings].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const deltaMinutes =
      (Date.parse(current.observedAt) - Date.parse(previous.observedAt)) / 60_000;
    if (previous.locationRef !== current.locationRef && deltaMinutes <= 5) {
      signals.push({
        kind: 'impossible-travel',
        detail: `travel:${previous.locationRef}->${current.locationRef}`,
        observedAt: current.observedAt,
      });
      break;
    }
  }
  return signals;
}

/* --------------------------------------------------------------- *
 * Snooping access → investigation case (REQ-ADM-019)              *
 * --------------------------------------------------------------- */

export const anomalyPatterns = [
  'credential-sharing',
  'concurrent-session',
  'snooping-access',
] as const;
export type AnomalyPattern = (typeof anomalyPatterns)[number];

/** One workforce access sighting evaluated for a snooping pattern. */
export interface AccessSighting {
  readonly accessRef: string;
  readonly subjectPersonId: PersonId;
  readonly segment: string;
  /** A documented treatment/coverage relationship existed for this access. */
  readonly hadTreatmentRelationship: boolean;
  /** The access was within the member's assignment scope. */
  readonly withinAssignment: boolean;
  readonly observedAt: string;
}

export interface SnoopingFinding {
  readonly accessRef: string;
  readonly subjectPersonId: PersonId;
  readonly segment: string;
  readonly observedAt: string;
}

/**
 * A snooping pattern (REQ-ADM-019): an access with NEITHER a treatment
 * relationship NOR an assignment basis. Minimum-necessary means such an access
 * is anomalous by construction — it is flagged, never silently trusted.
 */
export function detectSnooping(sightings: readonly AccessSighting[]): readonly SnoopingFinding[] {
  return sightings
    .filter((sighting) => !sighting.hadTreatmentRelationship && !sighting.withinAssignment)
    .map((sighting) => ({
      accessRef: sighting.accessRef,
      subjectPersonId: sighting.subjectPersonId,
      segment: sighting.segment,
      observedAt: sighting.observedAt,
    }));
}

export const anomalyCaseStatuses = ['open', 'contained', 'remediated', 'false-positive'] as const;
export type AnomalyCaseStatus = (typeof anomalyCaseStatuses)[number];

export const anomalyDispositions = [
  'confirmed-violation',
  'policy-clarification',
  'no-violation',
] as const;
export type AnomalyDisposition = (typeof anomalyDispositions)[number];

/** A forensic signal recorded VERBATIM on the case (never rewritten). */
export interface AnomalySignal {
  readonly signalRef: string;
  readonly detail: string;
  readonly observedAt: string;
}

export interface AccessAnomalyCase {
  readonly tenantId: TenantId;
  readonly anomalyId: string;
  readonly pattern: AnomalyPattern;
  /** The workforce member under investigation. */
  readonly subjectStaffPersonId: PersonId;
  readonly signals: readonly AnomalySignal[];
  readonly detectedAt: string;
  readonly status: AnomalyCaseStatus;
  readonly containmentRef: string | null;
  readonly disposition: AnomalyDisposition | null;
  readonly remediationEvidenceRef: string | null;
  readonly resolvedBy: string | null;
  readonly synthetic: true;
}

export interface OpenAnomalyRequest {
  readonly tenantId: TenantId;
  readonly anomalyId: string;
  readonly pattern: AnomalyPattern;
  readonly subjectStaffPersonId: PersonId;
  readonly signals: readonly AnomalySignal[];
  readonly detectedAt: string;
  readonly openedBy: string;
  /** Immediate containment directive ref (rate-limit / access-freeze), if any. */
  readonly containmentRef?: string;
}

export interface OpenAnomalyOutcome {
  readonly case: AccessAnomalyCase;
  readonly auditInput: ElevationConfigAuditInput;
  readonly investigationWorkItem: AuthorityReviewWorkItem;
}

/**
 * Open an access-anomaly investigation (REQ-ID-002 / REQ-ADM-019): the
 * triggering signals are recorded VERBATIM (the forensic record fails closed
 * on an empty signal set — mirrors the WP-014 ATO lockdown discipline), an
 * investigation WorkItem opens, and the opening is audited. The case is born
 * `open`; containment/remediation follow through `remediateAnomaly`.
 */
export function openAccessAnomalyInvestigation(request: OpenAnomalyRequest): OpenAnomalyOutcome {
  assertId(request.anomalyId, 'anomalyId');
  assertRef(request.openedBy, 'openedBy');
  assertInstant(request.detectedAt, 'detectedAt');
  if (request.signals.length === 0) {
    throw new ElevationError(
      `anomaly ${request.anomalyId} requires the triggering signals — the forensic record fails closed`,
    );
  }
  for (const signal of request.signals) {
    assertRef(signal.signalRef, 'signalRef');
    assertInstant(signal.observedAt, 'signal.observedAt');
  }
  if (request.containmentRef !== undefined) {
    assertRef(request.containmentRef, 'containmentRef');
  }
  const anomalyCase: AccessAnomalyCase = {
    tenantId: request.tenantId,
    anomalyId: request.anomalyId,
    pattern: request.pattern,
    subjectStaffPersonId: request.subjectStaffPersonId,
    signals: [...request.signals],
    detectedAt: request.detectedAt,
    status: request.containmentRef !== undefined ? 'contained' : 'open',
    containmentRef: request.containmentRef ?? null,
    disposition: null,
    remediationEvidenceRef: null,
    resolvedBy: null,
    synthetic: true,
  };
  const auditInput = configChangeAuditInput({
    auditId: `anomaly-open-${request.anomalyId}`,
    tenantId: request.tenantId,
    action: 'access-anomaly-investigation',
    actorRef: request.openedBy,
    occurredAt: request.detectedAt,
    configRef: `access-anomaly:${request.anomalyId}`,
    subjectRef: `person:${request.subjectStaffPersonId}`,
  });
  const investigationWorkItem: AuthorityReviewWorkItem = {
    workItemId: `anomaly-${request.anomalyId}`,
    origin: 'authority-review',
    subjectRef: `access-anomaly:${request.anomalyId}`,
    purpose: 'access-anomaly-investigation',
    risk: request.pattern === 'snooping-access' ? 'urgent' : 'elevated',
    serviceTier: 'security-investigation',
    slaPolicyId: null,
    policyVersion: null,
    responseDueAt: null,
    poolId: 'it-security-admin',
    openedAt: request.detectedAt,
  };
  return { case: anomalyCase, auditInput, investigationWorkItem };
}

export interface RemediateAnomalyRequest {
  readonly disposition: AnomalyDisposition;
  readonly remediationEvidenceRef: string;
  readonly resolvedBy: string;
  readonly occurredAt: string;
}

export interface RemediateAnomalyOutcome {
  readonly case: AccessAnomalyCase;
  readonly auditInput: ElevationConfigAuditInput;
}

/**
 * Resolve an investigation (REQ-ID-002 remediation half): a confirmed violation
 * or a cleared false positive, always with evidence and attribution
 * (fail-closed). The forensic signals are carried forward VERBATIM — resolution
 * adds fields, never rewrites the record of what was seen.
 */
export function remediateAnomaly(
  anomalyCase: AccessAnomalyCase,
  request: RemediateAnomalyRequest,
): RemediateAnomalyOutcome {
  assertRef(request.remediationEvidenceRef, 'remediationEvidenceRef');
  assertRef(request.resolvedBy, 'resolvedBy');
  assertInstant(request.occurredAt, 'occurredAt');
  if (anomalyCase.status === 'remediated' || anomalyCase.status === 'false-positive') {
    throw new ElevationError(`anomaly ${anomalyCase.anomalyId} is already resolved`);
  }
  const status: AnomalyCaseStatus =
    request.disposition === 'no-violation' ? 'false-positive' : 'remediated';
  const resolved: AccessAnomalyCase = {
    ...anomalyCase,
    status,
    disposition: request.disposition,
    remediationEvidenceRef: request.remediationEvidenceRef,
    resolvedBy: request.resolvedBy,
  };
  const auditInput = configChangeAuditInput({
    auditId: `anomaly-resolve-${anomalyCase.anomalyId}`,
    tenantId: anomalyCase.tenantId,
    action: 'access-anomaly-remediation',
    actorRef: request.resolvedBy,
    occurredAt: request.occurredAt,
    configRef: `access-anomaly:${anomalyCase.anomalyId}`,
    subjectRef: `person:${anomalyCase.subjectStaffPersonId}`,
  });
  return { case: resolved, auditInput };
}
