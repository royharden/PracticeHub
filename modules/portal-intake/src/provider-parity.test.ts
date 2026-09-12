import { InMemoryBlobStore } from '@practicehub/documents';
import type { AuthChallenge, PreAuthSession } from '@practicehub/identity';
import { describe, expect, it } from 'vitest';

import { RecordingWorkItemDouble } from './contract-doubles.js';
import {
  PracticeHubDocumentAdapter,
  PracticeHubIdentityAdapter,
  PracticeHubWorkItemAdapter,
} from './ports.js';

const workInput = {
  tenantId: 'northwind-synthetic',
  intakeRef: 'intake-synthetic-002',
  purpose: 'prospective-intake' as const,
  risk: 'routine' as const,
  responseDueAt: '2026-09-12T14:00:00Z',
  ownerRef: 'synthetic-guide:intake',
  poolRef: 'prospect-intake',
  occurredAt: '2026-09-12T10:00:00Z',
};

class WorkItemQueryable {
  private row: Record<string, unknown> | undefined;
  private readonly events: Array<Record<string, unknown>> = [];
  public async query(text: string, params: readonly unknown[] = []) {
    if (text.includes("WHERE origin='admin' AND subject_ref"))
      return { rows: this.row === undefined ? [] : [{ work_item_id: this.row['work_item_id'] }] };
    if (text.includes('SELECT * FROM events.work_item WHERE'))
      return { rows: this.row === undefined ? [] : [this.row] };
    if (text.includes('SELECT * FROM events.work_item_event')) return { rows: [...this.events] };
    if (text.includes('INSERT INTO events.work_item_event')) {
      this.events.push({
        tenant_id: params[0],
        work_item_id: params[1],
        event_seq: params[2],
        event_type: params[3],
        occurred_at: params[4],
        actor_ref: params[5],
        from_owner_ref: params[6],
        to_owner_ref: params[7],
        reason: params[8],
        timer_type: params[9],
        due_at: params[10],
        escalation_step: params[11],
        escalation_action: params[12],
        escalation_target: params[13],
        context_package: params[14],
        watcher_ref: params[15],
      });
      return { rows: [] };
    }
    if (text.includes('INSERT INTO events.work_item')) {
      this.row = {
        tenant_id: params[0],
        work_item_id: params[1],
        origin: params[2],
        subject_ref: params[3],
        purpose: params[4],
        risk: params[5],
        service_tier: params[6],
        sla_policy_id: params[7],
        policy_version: params[8],
        has_sla: params[9],
        status: params[10],
        priority: params[11],
        owner_ref: params[12],
        pool_id: params[13],
        watchers: JSON.parse(String(params[14])),
        escalated: params[15],
        opened_at: params[16],
        response_due_at: params[17],
        first_owned_at: params[18],
        last_event_seq: params[19],
      };
      return { rows: [] };
    }
    return { rows: [] };
  }
}

describe('real-provider parity', () => {
  it('WP-022 domain adapter and explicit double agree on receipt, status and retry', async () => {
    const real = new PracticeHubWorkItemAdapter(new WorkItemQueryable());
    for (const provider of [new RecordingWorkItemDouble(), real]) {
      const first = await provider.open(workInput);
      const retry = await provider.open(workInput);
      expect(first).toEqual(retry);
      expect(first.visibleStatus).toBe('submitted');
      expect(first.responseDueAt).toBe(workInput.responseDueAt);
      expect(first.workItemRef).toMatch(/^wi-/);
    }
    await expect(real.open({ ...workInput, poolRef: 'different-pool' })).rejects.toThrow(
      /retry changed/,
    );
  });

  it('WP-024 adapter uses content addressing and mandatory quarantine', async () => {
    const provider = new PracticeHubDocumentAdapter(new InMemoryBlobStore(), () => [
      'patient-name',
    ]);
    const input = {
      tenantId: 'northwind-synthetic',
      intakeRef: 'intake-synthetic-002',
      documentRef: 'portal-doc-synthetic-002',
      bytes: 'synthetic portal bytes',
      mediaType: 'application/pdf',
      pageCount: 1,
      actorRef: 'synthetic-system:portal-intake',
      occurredAt: '2026-09-12T10:00:00Z',
      synthetic: true as const,
    };
    const result = await provider.receive(input);
    expect(result.kind).toBe('quarantined');
    expect(result.blobRef).toBe(`blob://documents/${result.contentHash}`);
    await expect(provider.receive(input)).resolves.toEqual(result);
    await expect(provider.receive({ ...input, bytes: 'changed synthetic bytes' })).rejects.toThrow(
      /retry changed/,
    );
    const unsafe = new PracticeHubDocumentAdapter(new InMemoryBlobStore(), () => [
      'patient-name:synthetic-value',
    ]);
    await expect(
      unsafe.receive({ ...input, documentRef: 'portal-doc-synthetic-003' }),
    ).rejects.toThrow(/not allowed/);
  });

  it('WP-014 adapter refuses possession signals and accepts only a consumed elevation challenge', () => {
    const provider = new PracticeHubIdentityAdapter();
    const preAuth: PreAuthSession = {
      preAuthRef: 'preauth-synthetic-001',
      tenantId: 'northwind-synthetic' as PreAuthSession['tenantId'],
      caseRef: 'case-synthetic-001',
      approvedPublicTopics: ['services'],
      consentedLeadFields: {},
      synthetic: true,
    };
    expect(provider.elevate(preAuth, { presentedSignals: ['cookie', 'name-assertion'] }).kind).toBe(
      'withheld',
    );
    const challenge: AuthChallenge = {
      challengeId: 'challenge-synthetic-001',
      tenantId: preAuth.tenantId,
      personId: 'person-synthetic-001' as AuthChallenge['personId'],
      endpointId: 'endpoint-synthetic-001',
      purpose: 'elevation',
      method: 'otp',
      issuedAt: '2026-09-12T09:59:00Z',
      expiresAt: '2026-09-12T10:10:00Z',
      consumedAt: '2026-09-12T10:00:00Z',
      attemptCount: 1,
      maxAttempts: 3,
      synthetic: true,
    };
    const result = provider.elevate(preAuth, {
      presentedSignals: ['cookie'],
      consumedChallenge: challenge,
    });
    expect(result.kind).toBe('verified');
    if (result.kind === 'verified') expect(result.link.governedPersonId).toBe(challenge.personId);
  });
});
