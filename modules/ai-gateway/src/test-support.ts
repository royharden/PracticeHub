import { evaluateEgress, type VendorRegistryRow } from '@practicehub/platform-integration';
import type { TenantId } from '@practicehub/contracts';

import { AiGateway, type AiGatewayPorts } from './gateway.js';
import { DefaultToolAuthorization, sha256 } from './guards.js';
import type { InteractionEvidencePort, ModelProviderPort } from './ports.js';
import {
  RecordingContainment,
  RecordingEgressPolicy,
  RecordingEvidencePort,
  RecordingObjectStore,
  scopedBody,
} from './recording-ports.js';
import type { AiGatewayRequest, ModelProviderResult } from './types.js';

export const cleanProviderResult: ModelProviderResult = {
  status: 'accepted',
  receiptRef: 'receipt:rail-022:001',
  actualModelVersion: 'model-api-v1',
  outputBody: JSON.stringify({ candidate: 'synthetic-summary', synthetic: true }),
  toolProposals: [],
  requiresReconciliation: false,
  resendsExternalEffect: false,
  synthetic: true,
};

const tenant = 'northwind-synthetic' as TenantId;

export function requestFixture(overrides: Partial<AiGatewayRequest> = {}): AiGatewayRequest {
  const body = JSON.stringify({ note: 'synthetic source note', subject: 'subject:northwind:001' });
  return {
    tenantId: tenant,
    subjectRef: 'subject:northwind:001',
    useCase: 'draft-visit-summary',
    cohortRef: 'cohort-alpha',
    actorRef: 'staff:northwind:001',
    purpose: 'treatment',
    interactionRef: 'interaction:001',
    interactionEventId: '01J00000000000000000000001',
    interactionAuditId: 'audit-ai-001',
    egressEventId: '01J00000000000000000000002',
    egressAuditId: 'audit-egress-001',
    idempotencyKey: 'ai:interaction:001',
    occurredAt: '2026-06-01T09:00:00Z',
    mode: 'dev',
    dataClassification: 'PHI',
    phiCategories: ['ID', 'CLIN'],
    asOf: '2026-06-01',
    binding: {
      tenantId: tenant,
      useCase: 'draft-visit-summary',
      cohortRef: 'cohort-alpha',
      bindingRef: 'binding:summary:alpha',
      vendorId: 'synthetic-ai-covered',
      modelRef: 'model:synthetic-summary',
      pinnedModelVersion: 'model-api-v1',
      promptTemplateVersion: 'prompt-v1',
      systemPolicyRef: 'policy:ai:v1',
      version: 1,
      mode: 'dev',
      enabled: true,
      synthetic: true,
    },
    grant: {
      tenantId: tenant,
      actorRef: 'staff:northwind:001',
      subjectRef: 'subject:northwind:001',
      cohortRef: 'cohort-alpha',
      aiSystemRef: 'ai:summary',
      environment: 'dev',
      version: 1,
      purpose: 'treatment',
      allowedToolIds: ['tool:chart-read'],
      allowedArgumentKeysByTool: { 'tool:chart-read': ['subjectRef'] },
      requiredArgumentKeysByTool: { 'tool:chart-read': ['subjectRef'] },
      allowDraftSideEffect: false,
      humanApprovalRequired: true,
      enabled: true,
      synthetic: true,
    },
    content: [
      {
        tenantId: tenant,
        subjectRef: 'subject:northwind:001',
        bodyRef: 'source:note:001',
        bodyHash: sha256(body),
        originRef: 'ehr:synthetic-note',
        trust: 'untrusted-data',
        synthetic: true,
      },
    ],
    allowedOriginRefs: ['ehr:synthetic-note'],
    knownSubjectRefs: ['subject:northwind:001', 'subject:northwind:002'],
    secretCanaries: ['synthetic-secret-canary'],
    synthetic: true,
    ...overrides,
  };
}

function coveredVendor(): VendorRegistryRow {
  return {
    tenantId: tenant,
    vendorId: 'synthetic-ai-covered',
    vendorClass: 'ai-general',
    isAiVendor: true,
    enforcementPoint: 'ai-gateway',
    baaStatus: 'executed',
    baaEffective: '2026-01-01',
    baaExpiry: '2027-01-01',
    noTrainingOnPhi: true,
    zeroRetention: true,
    permittedCategories: ['ID', 'CLIN'],
    status: 'active',
    version: 1,
    synthetic: true,
  };
}

export function gatewayHarness(
  input: {
    readonly request?: AiGatewayRequest;
    readonly providerResult?: ModelProviderResult;
    readonly egressAllowed?: boolean;
    readonly capabilityAllowed?: boolean;
    readonly policyMismatch?: boolean;
    readonly provider?: ModelProviderPort;
    readonly evidencePort?: InteractionEvidencePort;
  } = {},
) {
  const request = input.request ?? requestFixture();
  const objects = new RecordingObjectStore();
  const source = request.content[0];
  if (source !== undefined) {
    objects.seed(
      scopedBody(request, {
        bodyRef: source.bodyRef,
        originRef: source.originRef,
        body: JSON.stringify({ note: 'synthetic source note', subject: request.subjectRef }),
      }),
    );
  }
  let providerCalls = 0;
  const recordingProvider: ModelProviderPort = {
    async complete() {
      providerCalls += 1;
      return input.providerResult ?? cleanProviderResult;
    },
  };
  const provider = input.provider ?? recordingProvider;
  const egressDecision = evaluateEgress(input.egressAllowed === false ? null : coveredVendor(), {
    tenantId: request.tenantId,
    vendorId: request.binding.vendorId,
    phiClass: request.dataClassification,
    categories: request.phiCategories,
    purpose: request.purpose,
    asOf: request.asOf,
    actorRef: request.actorRef,
    occurredAt: request.occurredAt,
  });
  const containment = new RecordingContainment();
  const evidence = new RecordingEvidencePort();
  const ports: AiGatewayPorts = {
    objects,
    provider,
    capability: {
      authorize: () => ({
        allowed: input.capabilityAllowed !== false,
        reason: input.capabilityAllowed === false ? 'synthetic-deny' : 'synthetic-test-grant',
      }),
    },
    policies: {
      load: async (loaded) =>
        input.policyMismatch === true ? null : { binding: loaded.binding, grant: loaded.grant },
    },
    egress: new RecordingEgressPolicy(egressDecision),
    tools: new DefaultToolAuthorization(),
    containment,
    evidence: input.evidencePort ?? evidence,
  };
  return {
    request,
    objects,
    containment,
    evidence,
    gateway: new AiGateway(ports),
    providerCalls: () => providerCalls,
  };
}
