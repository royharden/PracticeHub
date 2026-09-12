import type { Queryable } from '@practicehub/events';

import type { InteractionEvidence } from './types.js';

export async function insertInteraction(exec: Queryable, row: InteractionEvidence): Promise<void> {
  await exec.query(
    `INSERT INTO ai_gateway.interaction (
       tenant_id, subject_ref, interaction_ref, use_case, cohort_ref, actor_ref, purpose,
       event_id, audit_id, idempotency_key, occurred_at, model_ref, model_version,
       model_version_hash, audit_model_version_ref,
       binding_version, grant_version, prompt_ref, prompt_hash, output_ref, output_hash,
       tool_decision_ref, tool_decision_hash, tool_decision_count,
       provider_receipt_ref, decision, reason, synthetic
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12,$13,$14,$15,$16,$17,$18,$19,
       $20,$21,$22,$23,$24,$25,$26,$27,true
     )`,
    [
      row.tenantId,
      row.subjectRef,
      row.interactionRef,
      row.useCase,
      row.cohortRef,
      row.actorRef,
      row.purpose,
      row.eventId,
      row.auditId,
      row.idempotencyKey,
      row.occurredAt,
      row.modelRef,
      row.modelVersion,
      row.modelVersionHash,
      row.auditModelVersionRef,
      row.bindingVersion,
      row.grantVersion,
      row.promptRef,
      row.promptHash,
      row.outputRef,
      row.outputHash,
      row.toolDecisionRef,
      row.toolDecisionHash,
      row.toolDecisionCount,
      row.providerReceiptRef,
      row.decision,
      row.reason,
    ],
  );
}
