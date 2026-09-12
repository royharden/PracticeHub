import { describe, expect, it } from 'vitest';

import { PostgresPolicySnapshotPort } from './policy-store.js';
import { requestFixture } from './test-support.js';

describe('PostgresPolicySnapshotPort', () => {
  it('requires enabled dev synthetic rows at exact actor/subject/cohort versions', async () => {
    const request = requestFixture();
    const calls: Array<{ text: string; params: readonly unknown[] }> = [];
    const rows = [
      {
        use_case: request.binding.useCase,
        cohort_ref: request.binding.cohortRef,
        binding_ref: request.binding.bindingRef,
        vendor_id: request.binding.vendorId,
        model_ref: request.binding.modelRef,
        pinned_model_version: request.binding.pinnedModelVersion,
        prompt_template_version: request.binding.promptTemplateVersion,
        system_policy_ref: request.binding.systemPolicyRef,
        version: 1,
      },
      {
        actor_ref: request.grant.actorRef,
        subject_ref: request.grant.subjectRef,
        cohort_ref: request.grant.cohortRef,
        ai_system_ref: request.grant.aiSystemRef,
        version: 1,
        purpose: request.grant.purpose,
        allowed_tool_ids: request.grant.allowedToolIds,
        allowed_argument_keys_by_tool: request.grant.allowedArgumentKeysByTool,
        required_argument_keys_by_tool: request.grant.requiredArgumentKeysByTool,
        allow_draft_side_effect: false,
      },
    ];
    const exec = {
      async query(text: string, params: readonly unknown[] = []) {
        calls.push({ text, params });
        return { rows: [rows[calls.length - 1] as Record<string, unknown>] };
      },
    };
    await expect(new PostgresPolicySnapshotPort(exec).load(request)).resolves.toEqual({
      binding: request.binding,
      grant: request.grant,
    });
    expect(calls[0]?.text).toContain('enabled=true');
    expect(calls[1]?.params).toEqual([
      request.tenantId,
      request.actorRef,
      request.subjectRef,
      request.cohortRef,
      request.grant.aiSystemRef,
      request.grant.version,
    ]);
  });
});
