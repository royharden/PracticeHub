import type { EgressDecision } from '@practicehub/platform-integration';

import {
  assertOutputSafe,
  gatewayEgressRequest,
  GatewayRefusal,
  isolateContent,
  sha256,
  validateGatewayRequest,
} from './guards.js';
import type {
  ContainmentPort,
  EgressPolicyPort,
  InferenceAuthorizationPort,
  InteractionEvidencePort,
  ModelProviderPort,
  ObjectStorePort,
  PolicySnapshotPort,
  StoredBody,
  ToolAuthorizationPort,
} from './ports.js';
import type {
  AiGatewayDecision,
  AiGatewayRequest,
  GatewayBlockReason,
  InteractionEvidence,
  ModelProviderResult,
  ProviderPrompt,
  ToolAuthorizationDecision,
} from './types.js';

export interface AiGatewayPorts {
  readonly objects: ObjectStorePort;
  readonly provider: ModelProviderPort;
  readonly egress: EgressPolicyPort;
  readonly capability: InferenceAuthorizationPort;
  readonly policies: PolicySnapshotPort;
  readonly tools: ToolAuthorizationPort;
  readonly containment: ContainmentPort;
  readonly evidence: InteractionEvidencePort;
}

export class GatewayEvidenceError extends Error {
  public constructor(public override readonly cause: unknown) {
    super('AI gateway evidence commit failed; no authoritative decision may be returned');
    this.name = 'GatewayEvidenceError';
  }
}

const containmentReasons: readonly GatewayBlockReason[] = [
  'input-secret',
  'prompt-injection',
  'cross-subject-content',
  'object-scope-mismatch',
  'provider-egress-denied',
  'provider-failed',
  'malformed-provider-output',
  'model-version-drift',
  'output-secret',
  'output-cross-subject',
  'tool-denied',
];

function containmentScope(request: AiGatewayRequest) {
  return {
    tenantId: request.tenantId,
    useCase: request.useCase,
    cohortRef: request.cohortRef,
    bindingRef: request.binding.bindingRef,
  } as const;
}

function safeReason(error: unknown): GatewayBlockReason {
  return error instanceof GatewayRefusal ? error.reason : 'invalid-request';
}

function promptBody(prompt: ProviderPrompt): string {
  return JSON.stringify({ control: prompt.control, data: prompt.data });
}

function auditModelVersionRef(modelVersion: string): string {
  return /^[a-z0-9][a-z0-9:._/-]{0,199}$/u.test(modelVersion)
    ? modelVersion
    : `model-version-sha256:${sha256(modelVersion)}`;
}

export class AiGateway {
  public constructor(private readonly ports: AiGatewayPorts) {}

  public async invoke(request: AiGatewayRequest): Promise<AiGatewayDecision> {
    let providerCalls = 0;
    let promptObject: StoredBody | null = null;
    let providerResult: ModelProviderResult | null = null;
    let observedToolDecisions: readonly ToolAuthorizationDecision[] = [];
    let egressDecision: EgressDecision | undefined;

    const storeSafeArtifact = async (kind: string, reason: string): Promise<StoredBody> =>
      this.ports.objects.put({
        tenantId: request.tenantId,
        subjectRef: request.subjectRef,
        originRef: `gateway:${kind}`,
        body: JSON.stringify({
          interactionRef: request.interactionRef,
          kind,
          reason,
          synthetic: true,
        }),
        synthetic: true,
      });

    const commit = async (
      decision: AiGatewayDecision,
      output: StoredBody,
      reason: string,
      provider: ModelProviderResult | null,
    ): Promise<void> => {
      const prompt = promptObject ?? (await storeSafeArtifact('prompt-refused', reason));
      const toolDecisionObject = await this.ports.objects.put({
        tenantId: request.tenantId,
        subjectRef: request.subjectRef,
        originRef: 'gateway:tool-decisions',
        body: JSON.stringify({
          interactionRef: request.interactionRef,
          decisions: observedToolDecisions,
          synthetic: true,
        }),
        synthetic: true,
      });
      const modelVersion = provider?.actualModelVersion ?? request.binding.pinnedModelVersion;
      const evidence: InteractionEvidence = {
        tenantId: request.tenantId,
        subjectRef: request.subjectRef,
        interactionRef: request.interactionRef,
        useCase: request.useCase,
        cohortRef: request.cohortRef,
        actorRef: request.actorRef,
        purpose: request.purpose,
        eventId: request.interactionEventId,
        auditId: request.interactionAuditId,
        idempotencyKey: request.idempotencyKey,
        occurredAt: request.occurredAt,
        modelRef: request.binding.modelRef,
        modelVersion,
        modelVersionHash: sha256(modelVersion),
        auditModelVersionRef: auditModelVersionRef(modelVersion),
        bindingVersion: request.binding.version,
        grantVersion: request.grant.version,
        promptRef: prompt.bodyRef,
        promptHash: prompt.bodyHash,
        outputRef: output.bodyRef,
        outputHash: output.bodyHash,
        toolDecisionRef: toolDecisionObject.bodyRef,
        toolDecisionHash: toolDecisionObject.bodyHash,
        toolDecisionCount: observedToolDecisions.length,
        providerReceiptRef: provider?.receiptRef ?? null,
        decision: decision.kind,
        reason,
        synthetic: true,
      };
      try {
        await this.ports.evidence.commit({
          evidence,
          ...(egressDecision === undefined
            ? {}
            : {
                egressDecision,
                egressEventId: request.egressEventId,
                egressAuditId: request.egressAuditId,
              }),
        });
      } catch (error) {
        throw new GatewayEvidenceError(error);
      }
    };

    const contain = async (reason: GatewayBlockReason): Promise<void> => {
      if (!containmentReasons.includes(reason)) return;
      await this.ports.containment.kill({
        ...containmentScope(request),
        incidentRef: `incident:${request.interactionRef}:${reason}`,
        fallbackRef: `fallback:human:${request.useCase}`,
        reason,
        containedAt: request.occurredAt,
        synthetic: true,
      });
    };

    const blocked = async (reason: GatewayBlockReason): Promise<AiGatewayDecision> => {
      await contain(reason);
      const refusal = await storeSafeArtifact('refusal', reason);
      const decision: AiGatewayDecision = {
        kind: 'blocked',
        interactionRef: request.interactionRef,
        reason,
        refusalRef: refusal.bodyRef,
        refusalHash: refusal.bodyHash,
        providerCalls,
      };
      await commit(decision, refusal, reason, providerResult);
      return decision;
    };

    try {
      validateGatewayRequest(request);
      const contained = await this.ports.containment.current(containmentScope(request));
      if (contained !== null) {
        const fallback = await storeSafeArtifact('contained', contained.reason);
        const decision: AiGatewayDecision = {
          kind: 'contained',
          interactionRef: request.interactionRef,
          cohortRef: request.cohortRef,
          fallbackRef: contained.fallbackRef,
          providerCalls: 0,
        };
        await commit(decision, fallback, 'cohort-contained', null);
        return decision;
      }
      if (!this.ports.capability.authorize(request).allowed) {
        throw new GatewayRefusal('capability-denied', 'ai.gateway is below the simulated floor');
      }
      const trustedPolicies = await this.ports.policies.load(request);
      if (
        trustedPolicies === null ||
        JSON.stringify(trustedPolicies.binding) !== JSON.stringify(request.binding) ||
        JSON.stringify(trustedPolicies.grant) !== JSON.stringify(request.grant)
      ) {
        throw new GatewayRefusal(
          'policy-snapshot-mismatch',
          'caller snapshots do not match enabled trusted policy records',
        );
      }

      let objects: StoredBody[];
      try {
        objects = await Promise.all(
          request.content.map(async (ref) => this.ports.objects.get(ref)),
        );
      } catch {
        throw new GatewayRefusal('object-scope-mismatch', 'content object cannot be read in scope');
      }
      const data = isolateContent(request, objects);
      const prompt: ProviderPrompt = {
        tenantId: request.tenantId,
        subjectRef: request.subjectRef,
        interactionRef: request.interactionRef,
        idempotencyKey: request.idempotencyKey,
        occurredAt: request.occurredAt,
        control: {
          modelRef: request.binding.modelRef,
          pinnedModelVersion: request.binding.pinnedModelVersion,
          promptTemplateVersion: request.binding.promptTemplateVersion,
          systemPolicyRef: request.binding.systemPolicyRef,
          allowedToolIds: request.grant.allowedToolIds,
          synthetic: true,
        },
        data,
        synthetic: true,
      };
      promptObject = await this.ports.objects.put({
        tenantId: request.tenantId,
        subjectRef: request.subjectRef,
        originRef: 'gateway:prompt',
        body: promptBody(prompt),
        synthetic: true,
      });

      try {
        egressDecision = this.ports.egress.evaluate(gatewayEgressRequest(request));
      } catch {
        throw new GatewayRefusal('provider-egress-denied', 'provider egress policy failed closed');
      }
      if (!egressDecision.allow) return blocked('provider-egress-denied');

      providerCalls += 1;
      let result: ModelProviderResult;
      try {
        result = await this.ports.provider.complete(prompt);
      } catch {
        throw new GatewayRefusal('provider-failed', 'RAIL-022 provider failed closed');
      }
      providerResult = result;
      const output = await this.ports.objects.put({
        tenantId: request.tenantId,
        subjectRef: request.subjectRef,
        originRef: 'gateway:provider-output',
        body: result.outputBody,
        synthetic: true,
      });

      if (result.actualModelVersion !== request.binding.pinnedModelVersion) {
        await contain('model-version-drift');
        const decision: AiGatewayDecision = {
          kind: 'stale',
          interactionRef: request.interactionRef,
          reason: 'model-version-drift',
          outputRef: output.bodyRef,
          outputHash: output.bodyHash,
          toolDecisions: [],
        };
        await commit(decision, output, decision.reason, result);
        return decision;
      }
      if (result.status === 'malformed') {
        await contain('malformed-provider-output');
        const decision: AiGatewayDecision = {
          kind: 'stale',
          interactionRef: request.interactionRef,
          reason: 'malformed-provider-output',
          outputRef: output.bodyRef,
          outputHash: output.bodyHash,
          toolDecisions: [],
        };
        await commit(decision, output, decision.reason, result);
        return decision;
      }
      if (result.status !== 'accepted' && result.status !== 'deduplicated') {
        await contain('provider-failed');
        const decision: AiGatewayDecision = {
          kind: 'stale',
          interactionRef: request.interactionRef,
          reason: 'provider-failed',
          outputRef: output.bodyRef,
          outputHash: output.bodyHash,
          toolDecisions: [],
        };
        await commit(decision, output, decision.reason, result);
        return decision;
      }
      if (result.requiresReconciliation) {
        await contain('provider-failed');
        const decision: AiGatewayDecision = {
          kind: 'stale',
          interactionRef: request.interactionRef,
          reason: 'provider-failed',
          outputRef: output.bodyRef,
          outputHash: output.bodyHash,
          toolDecisions: [],
        };
        await commit(decision, output, decision.reason, result);
        return decision;
      }

      assertOutputSafe(request, result.outputBody);
      const toolDecisions = result.toolProposals.map((proposal) =>
        this.ports.tools.authorize({ request, proposal, grant: request.grant }),
      );
      observedToolDecisions = toolDecisions;
      if (toolDecisions.some((decision) => !decision.allow)) {
        await contain('tool-denied');
        const refusal = await storeSafeArtifact('refusal', 'tool-denied');
        const decision: AiGatewayDecision = {
          kind: 'blocked',
          interactionRef: request.interactionRef,
          reason: 'tool-denied',
          refusalRef: refusal.bodyRef,
          refusalHash: refusal.bodyHash,
          providerCalls,
        };
        await commit(decision, output, decision.reason, result);
        return decision;
      }
      const decision: AiGatewayDecision = {
        kind: 'completed',
        interactionRef: request.interactionRef,
        outputRef: output.bodyRef,
        outputHash: output.bodyHash,
        toolDecisions,
      };
      await commit(decision, output, 'candidate-for-human-review', result);
      return decision;
    } catch (error) {
      if (error instanceof GatewayEvidenceError) throw error;
      return blocked(safeReason(error));
    }
  }
}
