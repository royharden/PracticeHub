import type { PhClinicalResource } from '@practicehub/clinical-contracts';
import type { WorkItem } from '@practicehub/events';

export const labPurposes = ['lab.critical-closure', 'lab.expected-result-aging'] as const;
export type LabPurpose = (typeof labPurposes)[number];

export const resultSources = ['electronic', 'manual', 'device'] as const;
export type ResultSource = (typeof resultSources)[number];

export const reconciliationStates = [
  'not-applicable',
  'pending',
  'matched',
  'conflict',
  'adjudicated-manual',
  'adjudicated-electronic',
] as const;
export type ReconciliationState = (typeof reconciliationStates)[number];

export const closurePhases = ['paged', 'acknowledged', 'contacted', 'closed'] as const;
export type ClosurePhase = (typeof closurePhases)[number];

export interface ReadBack {
  readonly readBackBy: string;
  readonly readBackAt: string;
  readonly confirmedValue: string;
}

export interface DeviceCalibration {
  readonly deviceId: string;
  readonly lotId: string;
  readonly calibratedAt: string;
  readonly method: string;
}

export interface LabOrder {
  readonly orderId: string;
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly code: string;
  readonly display: string;
  readonly orderedAt: string;
  readonly expectedResultBy: string;
  readonly serviceRequest: PhClinicalResource;
  readonly status: 'awaiting-result' | 'resulted';
  readonly currentResultId: string | null;
  readonly synthetic: true;
}

export interface LabResult {
  readonly resultId: string;
  readonly tenantId: string;
  readonly orderId: string;
  readonly supersedesResultId: string | null;
  readonly value: string;
  readonly critical: boolean;
  readonly recordedAt: string;
  readonly source: ResultSource;
  readonly provisional: boolean;
  readonly reconciliation: ReconciliationState;
  readonly readBack: ReadBack | null;
  readonly calibration: DeviceCalibration | null;
  readonly observation: PhClinicalResource;
  readonly report: PhClinicalResource;
  readonly synthetic: true;
}

export interface CriticalClosure {
  readonly closureId: string;
  readonly tenantId: string;
  readonly orderId: string;
  readonly resultId: string;
  readonly phase: ClosurePhase;
  readonly pagedAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  readonly contactedAt: string | null;
  readonly contactEvidence: string | null;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly workItem: WorkItem;
  readonly synthetic: true;
}

export interface ExpectedResultAge {
  readonly tenantId: string;
  readonly orderId: string;
  readonly agedAt: string;
  readonly workItem: WorkItem;
  readonly synthetic: true;
}

export interface RecallCohort {
  readonly tenantId: string;
  readonly recallId: string;
  readonly deviceId: string;
  readonly lotId: string;
  readonly recalledAt: string;
  readonly resultIds: readonly string[];
  readonly synthetic: true;
}

export interface Reconciliation {
  readonly tenantId: string;
  readonly orderId: string;
  readonly manualResultId: string;
  readonly electronicResultId: string;
  readonly state: 'matched' | 'conflict' | 'adjudicated';
  readonly decision: 'keep-manual' | 'accept-electronic' | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly synthetic: true;
}
