import type {
  EgressDecision,
  EgressRequest,
  VendorRegistryRow,
} from '@practicehub/platform-integration';

import type {
  AiGatewayRequest,
  InteractionEvidence,
  ModelProviderResult,
  ProviderPrompt,
  ScopedBodyRef,
  ToolAuthorizationDecision,
  ToolGrantSnapshot,
  ToolProposal,
} from './types.js';

export interface StoredBody extends ScopedBodyRef {
  readonly body: string;
}

export interface ObjectStorePort {
  get(ref: ScopedBodyRef): Promise<StoredBody>;
  put(input: {
    readonly tenantId: AiGatewayRequest['tenantId'];
    readonly subjectRef: string;
    readonly originRef: string;
    readonly body: string;
    readonly synthetic: true;
  }): Promise<StoredBody>;
}

export interface ModelProviderPort {
  complete(prompt: ProviderPrompt): Promise<ModelProviderResult>;
}

export interface EgressPolicyPort {
  evaluate(request: EgressRequest): EgressDecision;
}

export interface InferenceAuthorizationPort {
  authorize(request: AiGatewayRequest): { readonly allowed: boolean; readonly reason: string };
}

export interface PolicySnapshotPort {
  load(request: AiGatewayRequest): Promise<{
    readonly binding: AiGatewayRequest['binding'];
    readonly grant: AiGatewayRequest['grant'];
  } | null>;
}

export type VendorRowResolver = (tenantId: string, vendorId: string) => VendorRegistryRow | null;

export interface ToolAuthorizationPort {
  authorize(input: {
    readonly request: AiGatewayRequest;
    readonly proposal: ToolProposal;
    readonly grant: ToolGrantSnapshot;
  }): ToolAuthorizationDecision;
}

export interface ContainmentRecord {
  readonly tenantId: AiGatewayRequest['tenantId'];
  readonly useCase: string;
  readonly cohortRef: string;
  readonly bindingRef: string;
  readonly incidentRef: string;
  readonly fallbackRef: string;
  readonly reason: string;
  readonly containedAt: string;
  readonly synthetic: true;
}

export interface ContainmentPort {
  current(
    scope: Pick<ContainmentRecord, 'tenantId' | 'useCase' | 'cohortRef' | 'bindingRef'>,
  ): Promise<ContainmentRecord | null>;
  kill(record: ContainmentRecord): Promise<void>;
}

export interface InteractionEvidencePort {
  commit(input: {
    readonly evidence: InteractionEvidence;
    readonly egressDecision?: EgressDecision;
    readonly egressEventId?: string;
    readonly egressAuditId?: string;
  }): Promise<void>;
}
