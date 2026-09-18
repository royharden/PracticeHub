import type {
  AuthorityContext,
  BookingReceipt,
  CapabilityPhase,
  CatalogSlot,
  ConstraintBundleSnapshot,
  ConstraintProviderRecord,
  SchedulingOperation,
  SchedulingScope,
  SlotOffer,
} from './types.js';

export interface CapabilityRequest {
  capability: 'scheduling.booking' | 'scheduling.protective';
  operation: SchedulingOperation;
  phase: CapabilityPhase;
  scope: SchedulingScope;
}

export interface CapabilityDecision {
  allowed: boolean;
  reason?: string;
}

export interface AuthorityRequest {
  operation: SchedulingOperation;
  phase: CapabilityPhase;
  scope: SchedulingScope;
  expected: AuthorityContext;
}

export interface SchedulingAuthorityPort {
  evaluate(request: AuthorityRequest): Promise<AuthorityContext>;
}

export interface SchedulingCapabilityPort {
  evaluate(request: CapabilityRequest): Promise<CapabilityDecision>;
}

export interface ProviderHoldRequest {
  effectIdentity: string;
  offer: SlotOffer;
  patientId: string;
  authorityEpoch: number;
}

export interface ProviderCommitRequest {
  effectIdentity: string;
  holdId: string;
  tenantId: string;
  authorityEpoch: number;
  expectedSourceVersion: number;
}

export interface ProviderProtectiveRequest {
  effectIdentity: string;
  tenantId: string;
  targetId: string;
  authorityEpoch: number;
}

export interface SchedulingProviderPort {
  readonly adapterId: string;
  readonly adapterMode: 'synthetic' | 'real';
  hold(request: ProviderHoldRequest): Promise<BookingReceipt>;
  commit(request: ProviderCommitRequest): Promise<BookingReceipt>;
  release(request: ProviderProtectiveRequest): Promise<BookingReceipt>;
  cancel(request: ProviderProtectiveRequest): Promise<BookingReceipt>;
}

export interface SchedulingClock {
  now(): string;
}

export interface ConstraintProviderPort {
  currentBundle(tenantId: string, bundleId: string): ConstraintBundleSnapshot | null;
  providerRecord(
    tenantId: string,
    providerId: string,
    bundleId: string,
  ): ConstraintProviderRecord | null;
}

export interface ResourceCatalogPort {
  list(tenantId: string, locationId?: string): readonly CatalogSlot[];
}
