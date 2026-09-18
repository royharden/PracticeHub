import { createHash } from 'node:crypto';

import type {
  AuthorityDecision,
  CapabilityContext,
  CapabilityGrant,
  CapabilityId,
  CapabilityRegistry,
  CapabilityState,
} from '@practicehub/platform-core';

export const TENANT_A = 'tenant-a';
export const TENANT_B = 'tenant-b';

/** Local-only. Never merge into capabilityRegistryV1. */
export const WP030_LOCAL_CAPABILITY_ID = 'comms.accountable-message-loop' as const;
export const WP031_LOCAL_CAPABILITY_ID = 'cash.paid-service-loop' as const;
export const WP032_LOCAL_CAPABILITY_ID = 'clinical.coexistence' as const;

export const WP032_DESCRIPTOR_JSON =
  '{"capabilityId":"clinical.coexistence","contract":"practicehub.wp032-capability-double","inputFields":["requestKey","tenantId","subjectRef","proposalRef","expectedSourceVersion","payloadHash"],"minimumState":"simulated","version":1}';

export const WP032_DESCRIPTOR_SHA256 = createHash('sha256')
  .update(WP032_DESCRIPTOR_JSON)
  .digest('hex');

export type WorkPackageLoop = 'WP-030' | 'WP-031' | 'WP-032';
export type BindingParity = 'real-consumer' | 'real-consumer-pending-tenant-fence' | 'versioned-double';

export type RecorderCategory =
  | 'queuedIntent'
  | 'drainedEffect'
  | 'bodyEntry'
  | 'sealedOutput'
  | 'adapterCall'
  | 'messageAppend'
  | 'ledgerMutation'
  | 'clinicalWrite'
  | 'reconciliation';

export const recorderCategories: readonly RecorderCategory[] = [
  'queuedIntent',
  'drainedEffect',
  'bodyEntry',
  'sealedOutput',
  'adapterCall',
  'messageAppend',
  'ledgerMutation',
  'clinicalWrite',
  'reconciliation',
];

export interface GateInput {
  readonly registry: CapabilityRegistry;
  readonly grants: readonly CapabilityGrant[];
  readonly grantSnapshotVersion: number;
  readonly context: CapabilityContext;
  readonly checkpoint: 'enqueue' | 'drain';
}

export interface TenantScopedLoopInput {
  readonly requestKey: string;
  readonly tenantId: string;
  readonly payloadHash: string;
  readonly synthetic: true;
}

export interface TenantScopedClinicalProposal {
  readonly requestKey: string;
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly proposalRef: string;
  readonly expectedSourceVersion: string;
  readonly payloadHash: string;
  readonly synthetic: true;
}

export interface ClinicalAcknowledgementInput {
  readonly tenantId: string;
  readonly requestKey: string;
  readonly effectId: string;
  readonly receiptId: string;
  readonly outcome: 'acknowledged' | 'unknown';
  readonly synthetic: true;
}

export interface RecorderEvent {
  readonly operationId: string;
  readonly effectId: string;
  readonly tenantId: string;
  readonly category: RecorderCategory;
  readonly checkpoint: 'enqueue' | 'drain' | 'ack';
  readonly capabilityId: CapabilityId;
  readonly grantState: CapabilityState | 'none';
  readonly grantSnapshotVersion: number;
  readonly payload: Readonly<Record<string, string>>;
  readonly synthetic: true;
}

export interface EffectSnapshot {
  readonly bodyEntries: Readonly<Record<string, readonly RecorderEvent[]>>;
  readonly queuedIntents: Readonly<Record<string, readonly RecorderEvent[]>>;
  readonly sealedOutputs: Readonly<Record<string, readonly RecorderEvent[]>>;
  readonly drainedEffects: Readonly<Record<string, readonly RecorderEvent[]>>;
  readonly ordered: readonly RecorderEvent[];
  readonly lastDecision: AuthorityDecision | null;
}

export interface LoopToggleBindingV1<TEnqueue, TDrain> {
  readonly contractVersion: 1;
  readonly workPackage: WorkPackageLoop;
  readonly capabilityId: CapabilityId;
  readonly parity: BindingParity;
  enqueue(input: TEnqueue, gate: GateInput): Promise<EffectSnapshot>;
  drain(input: TDrain, gate: GateInput): Promise<EffectSnapshot>;
}

export class HarnessError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HarnessError';
  }
}

export function localHarnessRegistry(): CapabilityRegistry {
  const definition = (
    capabilityId: CapabilityId,
    description: string,
  ): CapabilityRegistry['definitions'][number] => ({
    capabilityId,
    ownerRole: 'platform',
    dimensions: [],
    description,
  });
  return {
    version: 1,
    definitions: [
      definition(WP030_LOCAL_CAPABILITY_ID, 'local WP-030 double; not canonical'),
      definition(WP031_LOCAL_CAPABILITY_ID, 'local WP-031 double; not canonical'),
      definition(WP032_LOCAL_CAPABILITY_ID, 'local WP-032 double; not canonical'),
    ],
    edges: [],
    ceilings: [],
    approvalPolicy: {
      version: 1,
      status: 'draft',
      authorityApprovalMinimum: 1,
      rehearsedRollbackEvidencePrefix: 'rollback:',
    },
  };
}

export function intentHashFor(proposal: TenantScopedClinicalProposal): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        proposal.tenantId,
        proposal.subjectRef,
        proposal.proposalRef,
        proposal.expectedSourceVersion,
        proposal.payloadHash,
      ]),
    )
    .digest('hex');
}

export function effectIdFor(tenantId: string, requestKey: string, intentHash: string): string {
  return createHash('sha256').update(JSON.stringify([tenantId, requestKey, intentHash])).digest('hex');
}

export function assertDescriptorHash(): void {
  if (WP032_DESCRIPTOR_SHA256 !== 'bf73e87c0ef1d4116a8b69f899d8c48f33a2a983665bf08b9530aa5039dfea96') {
    throw new HarnessError('DESCRIPTOR_HASH_MISMATCH', WP032_DESCRIPTOR_SHA256);
  }
}
