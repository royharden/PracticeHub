import type { AuditEmitInput } from '@practicehub/audit-evidence';
import type { EventEnvelope, EventId } from '@practicehub/contracts';
import { runOutboxCommit, type Queryable } from '@practicehub/events';

import type { InteractionEvidencePort } from './ports.js';
import { insertInteraction } from './store.js';
import type { InteractionEvidence } from './types.js';

interface AiInteractionEventPayload {
  readonly interactionRef: string;
  readonly subjectRef: string;
  readonly cohortRef: string;
  readonly promptRef: string;
  readonly promptHash: string;
  readonly outputRef: string;
  readonly outputHash: string;
  readonly toolDecisionRef: string;
  readonly toolDecisionHash: string;
  readonly toolDecisionCount: number;
  readonly modelRef: string;
  readonly modelVersion: string;
  readonly modelVersionHash: string;
  readonly auditModelVersionRef: string;
  readonly decision: InteractionEvidence['decision'];
  readonly reason: string;
  readonly synthetic: true;
}

function aiAuditInput(row: InteractionEvidence): AuditEmitInput {
  return {
    auditId: row.auditId,
    tenantId: row.tenantId,
    stream: 'ai-interaction',
    action: `ai-interaction-${row.decision}`,
    actorRef: row.actorRef,
    occurredAt: row.occurredAt,
    subjectRef: row.subjectRef,
    purpose: row.purpose,
    modelRef: row.modelRef,
    modelVersion: row.auditModelVersionRef,
    promptRef: row.promptRef,
    promptHash: row.promptHash,
    outputRef: row.outputRef,
    outputHash: row.outputHash,
    detail: {
      interaction_ref: row.interactionRef,
      use_case: row.useCase,
      cohort_ref: row.cohortRef,
      decision: row.decision,
      reason: row.reason,
      tool_decision_ref: row.toolDecisionRef,
      tool_decision_hash: row.toolDecisionHash,
      tool_decision_count: String(row.toolDecisionCount),
      provider_model_version_hash: row.modelVersionHash,
    },
    synthetic: true,
  };
}

function interactionEnvelope(row: InteractionEvidence): EventEnvelope<AiInteractionEventPayload> {
  return {
    eventId: row.eventId as EventId,
    tenantId: row.tenantId,
    type: `ai.interaction.${row.decision}`,
    aggregate: { type: 'ai-interaction', id: row.interactionRef, version: 1 },
    occurredAt: row.occurredAt,
    recordedAt: row.occurredAt,
    source: { module: 'ai-gateway', actorRef: row.actorRef },
    correlationId: row.interactionRef,
    idempotencyKey: row.idempotencyKey,
    dataClassification: 'none',
    retentionClass: 'ai-interaction',
    ...(row.providerReceiptRef === null ? {} : { externalReceiptRef: row.providerReceiptRef }),
    payload: {
      interactionRef: row.interactionRef,
      subjectRef: row.subjectRef,
      cohortRef: row.cohortRef,
      promptRef: row.promptRef,
      promptHash: row.promptHash,
      outputRef: row.outputRef,
      outputHash: row.outputHash,
      toolDecisionRef: row.toolDecisionRef,
      toolDecisionHash: row.toolDecisionHash,
      toolDecisionCount: row.toolDecisionCount,
      modelRef: row.modelRef,
      modelVersion: row.modelVersion,
      modelVersionHash: row.modelVersionHash,
      auditModelVersionRef: row.auditModelVersionRef,
      decision: row.decision,
      reason: row.reason,
      synthetic: true,
    },
    synthetic: true,
  };
}

/**
 * Concrete WP-020/WP-021 binding. The supplied Queryable must already be inside
 * one caller-owned transaction. Two runOutboxCommit calls therefore commit or
 * roll back together: optional disclosure decision first, then interaction row,
 * event, and ai-interaction audit record.
 */
export class EventAuditEvidencePort implements InteractionEvidencePort {
  public constructor(private readonly exec: Queryable) {}

  public async commit(input: Parameters<InteractionEvidencePort['commit']>[0]): Promise<void> {
    const row = input.evidence;
    if (input.egressDecision !== undefined) {
      if (input.egressEventId === undefined || input.egressAuditId === undefined) {
        throw new Error('egress evidence requires its exact event and audit ids');
      }
      const audit: AuditEmitInput = {
        auditId: input.egressAuditId,
        ...input.egressDecision.auditInput,
      };
      await runOutboxCommit(this.exec, {
        envelope: {
          eventId: input.egressEventId as EventId,
          tenantId: row.tenantId,
          type: input.egressDecision.allow ? 'ai.egress.allowed' : 'ai.egress.blocked',
          aggregate: { type: 'ai-egress', id: row.interactionRef, version: 1 },
          occurredAt: row.occurredAt,
          recordedAt: row.occurredAt,
          source: { module: 'ai-gateway', actorRef: row.actorRef },
          correlationId: row.interactionRef,
          idempotencyKey: `${row.idempotencyKey}:egress`,
          dataClassification: 'none',
          retentionClass: 'ai-interaction',
          payload: {
            interactionRef: row.interactionRef,
            decision: input.egressDecision.allow ? 'allow' : 'deny',
            reason: input.egressDecision.reason,
            synthetic: true,
          },
          synthetic: true,
        },
        auditInput: audit,
      });
    }
    await runOutboxCommit(this.exec, {
      envelope: interactionEnvelope(row),
      sideEffect: async (exec) => insertInteraction(exec, row),
      auditInput: aiAuditInput(row),
    });
  }
}
