import type { PhiClass, TenantId } from '@practicehub/contracts';
import type { PhiCategory } from '@practicehub/platform-integration';

export const gatewayBlockReasons = [
  'invalid-request',
  'prod-mode-disabled',
  'capability-denied',
  'policy-snapshot-mismatch',
  'cohort-contained',
  'object-scope-mismatch',
  'object-hash-mismatch',
  'input-secret',
  'prompt-injection',
  'cross-subject-content',
  'origin-not-allowed',
  'provider-egress-denied',
  'provider-failed',
  'malformed-provider-output',
  'model-version-drift',
  'output-secret',
  'output-cross-subject',
  'tool-denied',
] as const;
export type GatewayBlockReason = (typeof gatewayBlockReasons)[number];

export interface ScopedBodyRef {
  readonly tenantId: TenantId;
  readonly subjectRef: string;
  readonly bodyRef: string;
  readonly bodyHash: string;
  readonly originRef: string;
  readonly trust: 'untrusted-data';
  readonly synthetic: true;
}

export interface IsolatedContentBlock {
  readonly originRef: string;
  readonly bodyRef: string;
  readonly bodyHash: string;
  readonly body: string;
  readonly trust: 'untrusted-data';
}

export interface GatewayControlFrame {
  readonly modelRef: string;
  readonly pinnedModelVersion: string;
  readonly promptTemplateVersion: string;
  readonly systemPolicyRef: string;
  readonly allowedToolIds: readonly string[];
  readonly synthetic: true;
}

export interface ProviderPrompt {
  readonly tenantId: TenantId;
  readonly subjectRef: string;
  readonly interactionRef: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly control: GatewayControlFrame;
  readonly data: readonly IsolatedContentBlock[];
  readonly synthetic: true;
}

export interface ToolProposal {
  readonly toolId: string;
  readonly arguments: Readonly<Record<string, string>>;
  readonly sideEffect: 'none' | 'draft' | 'consequential';
  readonly requestedPurpose: string;
  readonly synthetic: true;
}

export interface ToolGrantSnapshot {
  readonly tenantId: TenantId;
  readonly actorRef: string;
  readonly subjectRef: string;
  readonly cohortRef: string;
  readonly aiSystemRef: string;
  readonly environment: 'dev';
  readonly version: number;
  readonly purpose: string;
  readonly allowedToolIds: readonly string[];
  readonly allowedArgumentKeysByTool: Readonly<Record<string, readonly string[]>>;
  readonly requiredArgumentKeysByTool: Readonly<Record<string, readonly string[]>>;
  readonly allowDraftSideEffect: boolean;
  readonly humanApprovalRequired: true;
  readonly enabled: true;
  readonly synthetic: true;
}

export interface ToolAuthorizationDecision {
  readonly allow: boolean;
  readonly reason: string;
  readonly grantVersion: number;
  /** Always inert. WP-100 never executes a tool or releases consequential output. */
  readonly proposal: ToolProposal;
}

export interface ModelBinding {
  readonly tenantId: TenantId;
  readonly useCase: string;
  readonly cohortRef: string;
  readonly bindingRef: string;
  readonly vendorId: string;
  readonly modelRef: string;
  readonly pinnedModelVersion: string;
  readonly promptTemplateVersion: string;
  readonly systemPolicyRef: string;
  readonly version: number;
  readonly mode: 'dev';
  readonly enabled: true;
  readonly synthetic: true;
}

export interface AiGatewayRequest {
  readonly tenantId: TenantId;
  readonly subjectRef: string;
  readonly useCase: string;
  readonly cohortRef: string;
  readonly actorRef: string;
  readonly purpose: string;
  readonly interactionRef: string;
  readonly interactionEventId: string;
  readonly interactionAuditId: string;
  readonly egressEventId: string;
  readonly egressAuditId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly mode: 'dev' | 'prod';
  readonly dataClassification: PhiClass;
  readonly phiCategories: readonly PhiCategory[];
  readonly asOf: string;
  readonly binding: ModelBinding;
  readonly grant: ToolGrantSnapshot;
  readonly content: readonly ScopedBodyRef[];
  readonly allowedOriginRefs: readonly string[];
  readonly knownSubjectRefs: readonly string[];
  readonly secretCanaries: readonly string[];
  readonly synthetic: true;
}

export interface ModelProviderResult {
  readonly status: 'accepted' | 'deduplicated' | 'uncertain' | 'rejected' | 'malformed';
  readonly receiptRef: string | null;
  readonly actualModelVersion: string;
  readonly outputBody: string;
  readonly toolProposals: readonly ToolProposal[];
  readonly requiresReconciliation: boolean;
  readonly resendsExternalEffect: false;
  readonly synthetic: true;
}

export type AiGatewayDecision =
  | {
      readonly kind: 'completed';
      readonly interactionRef: string;
      readonly outputRef: string;
      readonly outputHash: string;
      readonly toolDecisions: readonly ToolAuthorizationDecision[];
    }
  | {
      readonly kind: 'blocked';
      readonly interactionRef: string;
      readonly reason: GatewayBlockReason;
      readonly refusalRef: string;
      readonly refusalHash: string;
      readonly providerCalls: number;
    }
  | {
      readonly kind: 'stale';
      readonly interactionRef: string;
      readonly reason: 'model-version-drift' | 'provider-failed' | 'malformed-provider-output';
      readonly outputRef: string;
      readonly outputHash: string;
      readonly toolDecisions: readonly [];
    }
  | {
      readonly kind: 'contained';
      readonly interactionRef: string;
      readonly cohortRef: string;
      readonly fallbackRef: string;
      readonly providerCalls: 0;
    };

export interface InteractionEvidence {
  readonly tenantId: TenantId;
  readonly subjectRef: string;
  readonly interactionRef: string;
  readonly useCase: string;
  readonly cohortRef: string;
  readonly actorRef: string;
  readonly purpose: string;
  readonly eventId: string;
  readonly auditId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly modelRef: string;
  /** Exact provider-observed version; it may not satisfy the audit ref grammar. */
  readonly modelVersion: string;
  readonly modelVersionHash: string;
  /** Audit-safe, losslessly tied opaque reference for the exact modelVersion. */
  readonly auditModelVersionRef: string;
  readonly bindingVersion: number;
  readonly grantVersion: number;
  readonly promptRef: string;
  readonly promptHash: string;
  readonly outputRef: string;
  readonly outputHash: string;
  readonly toolDecisionRef: string;
  readonly toolDecisionHash: string;
  readonly toolDecisionCount: number;
  readonly providerReceiptRef: string | null;
  readonly decision: AiGatewayDecision['kind'];
  readonly reason: string;
  readonly synthetic: true;
}
