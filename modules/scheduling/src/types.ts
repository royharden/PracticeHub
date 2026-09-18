export type AuthorityMode = 'active' | 'shadow' | 'read-only' | 'retiring';
export type CapabilityPhase = 'enqueue' | 'drain';
export type SchedulingOperation =
  'hold-slot' | 'commit-booking' | 'cancel-appointment' | 'release-hold' | 'reconcile-receipt';

export interface SchedulingScope {
  tenantId: string;
  locationId: string;
  providerId: string;
  resourceIds: readonly string[];
}

export interface AuthorityContext {
  mode: AuthorityMode;
  epoch: number;
  sourceVersion: number;
}

export interface TimeInterval {
  start: string;
  end: string;
}

export interface PolicySnapshot {
  version: string;
  acceptingNewPatients: boolean;
  capturedAt: string;
}

export interface ClinicalPrerequisites {
  state: 'complete' | 'needs-verification' | 'blocked';
  reason?: string;
}

export interface SlotOffer extends SchedulingScope, TimeInterval {
  slotId: string;
  serviceId: string;
  policy: PolicySnapshot;
  adapterId: string;
  adapterMode: 'synthetic' | 'real';
  sourceVersion: number;
}

export interface Hold extends SlotOffer {
  holdId: string;
  patientId: string;
  expiresAt: string;
  authorityEpoch: number;
  state: 'live' | 'converted' | 'released' | 'expired' | 'indeterminate';
}

export interface Appointment extends SchedulingScope, TimeInterval {
  appointmentId: string;
  patientId: string;
  serviceId: string;
  state: 'booked' | 'cancelled' | 'superseded';
  version: number;
  predecessorAppointmentId?: string;
}

export interface BookingReceipt {
  receiptId: string;
  tenantId: string;
  effectIdentity: string;
  adapterId: string;
  adapterMode: 'synthetic' | 'real';
  authorityEpoch: number;
  sourceVersion: number;
  appointmentId?: string;
}

export interface WorkItemObligation {
  obligationId: string;
  type: 'WP-022';
  reason: 'needs-verification';
  tenantId: string;
  patientId: string;
  ownerRef: string;
  state: 'open' | 'taken' | 'resolved';
}

export interface HoldSlotCommand {
  idempotencyKey: string;
  offer: SlotOffer;
  patientId: string;
  authority: AuthorityContext;
  prerequisites: ClinicalPrerequisites;
  now: string;
  holdDurationMinutes: number;
}

export interface CommitBookingCommand {
  idempotencyKey: string;
  holdId: string;
  scope: SchedulingScope;
  expectedSourceVersion: number;
  authority: AuthorityContext;
  currentPolicy: PolicySnapshot;
  now: string;
}

export interface WaitlistEntry {
  waitlistEntryId: string;
  tenantId: string;
  patientId: string;
  requestedInterval: TimeInterval;
  originalAppointmentId?: string;
  originalAppointmentVersion?: number;
  offerExpiresAt?: string;
  state: 'waiting' | 'offered' | 'fulfilled' | 'withdrawn';
}

export type SchedulingErrorCode =
  | 'CAPABILITY_DENIED'
  | 'AUTHORITY_NOT_ACTIVE'
  | 'AUTHORITY_EPOCH_STALE'
  | 'SOURCE_VERSION_STALE'
  | 'POLICY_REVALIDATION_REQUIRED'
  | 'SLOT_NO_LONGER_AVAILABLE'
  | 'RESOURCE_CONFLICT'
  | 'PATIENT_CONFLICT'
  | 'PROVIDER_CONFLICT'
  | 'HOLD_EXPIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RECONCILIATION_REQUIRED'
  | 'CLINICAL_PREREQUISITE_UNMET'
  | 'ADAPTER_DOUBLE_ONLY';

export class SchedulingError extends Error {
  constructor(
    readonly code: SchedulingErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'SchedulingError';
  }
}

export type ConstraintKind = 'hard' | 'soft';

export interface SchedulingConstraint {
  constraintId: string;
  kind: ConstraintKind;
  dimension: string;
  requiredValue: string;
}

export interface ConstraintBundleSnapshot {
  bundleId: string;
  version: number;
  constraints: readonly SchedulingConstraint[];
}

export interface ConstraintProviderRecord {
  providerId: string;
  bundleId: string;
  version: number;
  values: Readonly<Record<string, string>>;
  stale: boolean;
}

export type ConstraintEvaluation =
  | { outcome: 'satisfied'; bundleVersion: number }
  | {
      outcome: 'withdrawn';
      reason: 'constraint-version-changed';
      offerVersion: number;
      currentVersion: number;
    }
  | { outcome: 'human-scheduler'; reason: 'missing-or-stale-provider-data' }
  | { outcome: 'unsatisfied'; failedHard: readonly string[]; softTradeoffs: readonly string[] };

export interface CatalogSlot extends SlotOffer {
  locationId: string;
  setupMinutes: number;
  cleanupMinutes: number;
  outOfService: boolean;
  interpreterRequired?: boolean;
}

export interface LinkedResourceNeed {
  resourceId: string;
  resourceType:
    'staff' | 'room' | 'equipment' | 'interpreter' | 'partner' | 'transport' | 'preparation';
  required: boolean;
  available: boolean;
}

export interface ResourceUnavailableTask {
  taskId: string;
  owner: string;
  sla: string;
  resourceId: string;
  state: 'open';
}

export interface WaitlistPriorityPause {
  waitlistEntryId: string;
  reason: string;
  owner: string;
  originalPriority: number;
  reevaluationDeadline: string;
  state: 'paused' | 'restored' | 'closed';
}

export interface ManagerSchedulingException {
  exceptionId: string;
  rationale: string;
  scope: string;
  duration: TimeInterval;
  impactedResourceIds: readonly string[];
  approvedBy: string;
}
