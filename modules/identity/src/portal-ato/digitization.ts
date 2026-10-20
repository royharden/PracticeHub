/**
 * Post-outage digitization and e-sign outage accounting (WP-099; REQ-PLAT-033). A scan links to
 * exactly one paper capture or it is quarantined for human linkage, never attached to a guessed
 * record; a paper consent that conflicts with a later electronic one goes to compliance review,
 * never overwrites; unlinked captures age on a worklist; outages are measured against the SLA.
 */

import type { PaperConsentLedgerPort } from './ports.js';
import {
  ConsentFallbackError,
  type DigitizationOutcome,
  type EsignOutageRecord,
  type EsignOutageReport,
  type EsignSla,
  type PaperConsentScan,
  type PendingPaperConsent,
} from './types.js';

function instant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ConsentFallbackError(`${label} is not an ISO-8601 instant: ${value}`);
  }
  return parsed;
}

export function digitizeScan(
  scan: PaperConsentScan,
  pending: readonly PendingPaperConsent[],
  ledger: PaperConsentLedgerPort,
  digitizedBy: string,
  digitizedAt: string,
): DigitizationOutcome {
  if (scan.synthetic !== true) throw new ConsentFallbackError('scan must be synthetic');
  if (!digitizedBy) throw new ConsentFallbackError('digitization names who linked the scan');
  instant(digitizedAt, 'digitizedAt');
  const quarantine = (
    reason: 'no-match' | 'ambiguous-match' | 'version-mismatch',
  ): DigitizationOutcome => ({ status: 'quarantined', scanId: scan.scanId, reason });
  if (scan.patientRef === null || scan.encounterRef === null) return quarantine('no-match');
  const candidates = pending.filter(
    (capture) =>
      capture.patientRef === scan.patientRef &&
      capture.encounterRef === scan.encounterRef &&
      capture.formId === scan.formId,
  );
  if (candidates.length === 0) return quarantine('no-match');
  const exact = candidates.filter((capture) => capture.version === scan.version);
  if (exact.length === 0) return quarantine('version-mismatch');
  const [capture, ...others] = exact;
  if (capture === undefined || others.length > 0) return quarantine('ambiguous-match');
  if (ledger.hasPaperConsent(capture.captureId)) {
    return { status: 'already-linked', captureId: capture.captureId };
  }
  const electronic = ledger.latestElectronicConsent(capture.patientRef, capture.formId);
  if (
    electronic !== null &&
    instant(electronic.signedAt, 'electronic signedAt') > instant(capture.capturedAt, 'capturedAt')
  ) {
    return {
      status: 'compliance-review',
      scanId: scan.scanId,
      captureId: capture.captureId,
      reason: 'conflicts-with-later-electronic',
    };
  }
  const entry = {
    captureId: capture.captureId,
    scanId: scan.scanId,
    patientRef: capture.patientRef,
    encounterRef: capture.encounterRef,
    formId: capture.formId,
    version: capture.version,
    provenance: {
      medium: 'paper' as const,
      capturedDuringOutage: capture.outageId,
      capturedAt: capture.capturedAt,
      capturedBy: capture.capturedBy,
      digitizedAt,
      digitizedBy,
    },
    synthetic: true as const,
  };
  ledger.appendPaperConsent(entry);
  return { status: 'linked', entry };
}

/** Every paper capture not yet on the ledger, oldest first, with overdue ones flagged (AC4). */
export function digitizationWorklist(
  pending: readonly PendingPaperConsent[],
  ledger: PaperConsentLedgerPort,
  asOf: string,
  overdueAfterHours: number,
): readonly {
  readonly captureId: string;
  readonly formId: string;
  readonly ageHours: number;
  readonly overdue: boolean;
}[] {
  const now = instant(asOf, 'asOf');
  return pending
    .filter((capture) => !ledger.hasPaperConsent(capture.captureId))
    .map((capture) => {
      const ageHours = (now - instant(capture.capturedAt, 'capturedAt')) / 3_600_000;
      return {
        captureId: capture.captureId,
        formId: capture.formId,
        ageHours,
        overdue: ageHours >= overdueAfterHours,
      };
    })
    .sort((a, b) => b.ageHours - a.ageHours || a.captureId.localeCompare(b.captureId));
}

/**
 * Close an outage against the vendor SLA (REQ-PLAT-033 AC3/EX3). A breach, or recurrence past
 * the review threshold, escalates to a vendor-accountability review instead of being absorbed.
 */
export function reportEsignOutage(
  outage: EsignOutageRecord,
  sla: EsignSla,
  priorOutagesInReviewWindow: number,
): EsignOutageReport {
  const start = instant(outage.startedAt, 'startedAt');
  const end = instant(outage.endedAt, 'endedAt');
  if (end < start)
    throw new ConsentFallbackError(`outage ${outage.outageId} ends before it starts`);
  const durationMinutes = (end - start) / 60_000;
  const reasons: string[] = [];
  const slaBreached = durationMinutes > sla.maxOutageMinutes;
  if (slaBreached) reasons.push(`duration ${durationMinutes}m > ${sla.maxOutageMinutes}m`);
  const occurrences = priorOutagesInReviewWindow + 1;
  if (occurrences > sla.maxOutagesPerReview) {
    reasons.push(`${occurrences} outages > ${sla.maxOutagesPerReview} per review window`);
  }
  return {
    outageId: outage.outageId,
    durationMinutes,
    affectedPatients: new Set(outage.affectedPatientRefs).size,
    heldVisits: new Set(outage.heldCheckInIds).size,
    slaBreached,
    escalation: reasons.length > 0 ? 'vendor-accountability-review' : null,
    reasons,
  };
}
