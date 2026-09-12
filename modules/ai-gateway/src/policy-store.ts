import type { Queryable } from '@practicehub/events';

import type { PolicySnapshotPort } from './ports.js';
import type { ModelBinding, ToolGrantSnapshot } from './types.js';

export class PostgresPolicySnapshotPort implements PolicySnapshotPort {
  public constructor(private readonly exec: Queryable) {}

  public async load(request: Parameters<PolicySnapshotPort['load']>[0]) {
    const bindingResult = await this.exec.query(
      `SELECT use_case,cohort_ref,binding_ref,vendor_id,model_ref,pinned_model_version,
              prompt_template_version,system_policy_ref,version,mode,enabled,synthetic
         FROM ai_gateway.model_binding
        WHERE tenant_id=$1 AND binding_ref=$2 AND version=$3 AND enabled=true
          AND mode='dev' AND synthetic=true
        FOR SHARE`,
      [request.tenantId, request.binding.bindingRef, request.binding.version],
    );
    const grantResult = await this.exec.query(
      `SELECT actor_ref,subject_ref,cohort_ref,ai_system_ref,environment,version,purpose,
              allowed_tool_ids,allowed_argument_keys_by_tool,required_argument_keys_by_tool,
              allow_draft_side_effect,human_approval_required,enabled,synthetic
         FROM ai_gateway.tool_grant
        WHERE tenant_id=$1 AND actor_ref=$2 AND subject_ref=$3 AND cohort_ref=$4
          AND ai_system_ref=$5 AND version=$6 AND enabled=true
          AND environment='dev' AND synthetic=true
        FOR SHARE`,
      [
        request.tenantId,
        request.actorRef,
        request.subjectRef,
        request.cohortRef,
        request.grant.aiSystemRef,
        request.grant.version,
      ],
    );
    const bindingRow = bindingResult.rows[0];
    const grantRow = grantResult.rows[0];
    if (bindingRow === undefined || grantRow === undefined) return null;
    const binding: ModelBinding = {
      tenantId: request.tenantId,
      useCase: String(bindingRow['use_case']),
      cohortRef: String(bindingRow['cohort_ref']),
      bindingRef: String(bindingRow['binding_ref']),
      vendorId: String(bindingRow['vendor_id']),
      modelRef: String(bindingRow['model_ref']),
      pinnedModelVersion: String(bindingRow['pinned_model_version']),
      promptTemplateVersion: String(bindingRow['prompt_template_version']),
      systemPolicyRef: String(bindingRow['system_policy_ref']),
      version: Number(bindingRow['version']),
      mode: 'dev',
      enabled: true,
      synthetic: true,
    };
    const grant: ToolGrantSnapshot = {
      tenantId: request.tenantId,
      actorRef: String(grantRow['actor_ref']),
      subjectRef: String(grantRow['subject_ref']),
      cohortRef: String(grantRow['cohort_ref']),
      aiSystemRef: String(grantRow['ai_system_ref']),
      environment: 'dev',
      version: Number(grantRow['version']),
      purpose: String(grantRow['purpose']),
      allowedToolIds: grantRow['allowed_tool_ids'] as string[],
      allowedArgumentKeysByTool: grantRow['allowed_argument_keys_by_tool'] as Record<
        string,
        string[]
      >,
      requiredArgumentKeysByTool: grantRow['required_argument_keys_by_tool'] as Record<
        string,
        string[]
      >,
      allowDraftSideEffect: Boolean(grantRow['allow_draft_side_effect']),
      humanApprovalRequired: true,
      enabled: true,
      synthetic: true,
    };
    return { binding, grant };
  }
}
