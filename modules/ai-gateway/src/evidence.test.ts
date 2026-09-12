import type { TenantId } from '@practicehub/contracts';
import { evaluateEgress, type VendorRegistryRow } from '@practicehub/platform-integration';
import { describe, expect, it } from 'vitest';

import { EventAuditEvidencePort } from './evidence.js';
import type { InteractionEvidence } from './types.js';

const tenant = 'northwind-synthetic' as TenantId;
const evidence: InteractionEvidence = {
  tenantId: tenant,
  subjectRef: 'subject:northwind:001',
  interactionRef: 'interaction:001',
  useCase: 'draft-visit-summary',
  cohortRef: 'cohort-alpha',
  actorRef: 'staff:northwind:001',
  purpose: 'treatment',
  eventId: '01J00000000000000000000001',
  auditId: 'audit-ai-001',
  idempotencyKey: 'ai:interaction:001',
  occurredAt: '2026-06-01T09:00:00Z',
  modelRef: 'model:synthetic-summary',
  modelVersion: 'model-api-v1',
  modelVersionHash: 'd'.repeat(64),
  auditModelVersionRef: 'model-api-v1',
  bindingVersion: 1,
  grantVersion: 1,
  promptRef: 'object:ai:prompt',
  promptHash: 'a'.repeat(64),
  outputRef: 'object:ai:output',
  outputHash: 'b'.repeat(64),
  toolDecisionRef: 'object:ai:tools',
  toolDecisionHash: 'c'.repeat(64),
  toolDecisionCount: 1,
  providerReceiptRef: 'receipt:rail-022:001',
  decision: 'completed',
  reason: 'candidate-for-human-review',
  synthetic: true,
};

const vendor: VendorRegistryRow = {
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

describe('EventAuditEvidencePort', () => {
  it('writes egress and interaction event/audit evidence through the caller transaction', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const exec = {
      async query(text: string, params: readonly unknown[] = []) {
        queries.push({ text, params });
        return { rows: [] };
      },
    };
    const egressDecision = evaluateEgress(vendor, {
      tenantId: tenant,
      vendorId: vendor.vendorId,
      phiClass: 'PHI',
      categories: ['ID', 'CLIN'],
      purpose: 'treatment',
      asOf: '2026-06-01',
      actorRef: evidence.actorRef,
      occurredAt: evidence.occurredAt,
    });
    await new EventAuditEvidencePort(exec).commit({
      evidence,
      egressDecision,
      egressEventId: '01J00000000000000000000002',
      egressAuditId: 'audit-egress-001',
    });

    expect(
      queries.filter((query) => query.text.includes('INSERT INTO events.outbox (')),
    ).toHaveLength(2);
    expect(
      queries.filter((query) => query.text.includes('INSERT INTO audit_evidence.audit_event')),
    ).toHaveLength(2);
    expect(
      queries.filter((query) => query.text.includes('INSERT INTO ai_gateway.interaction')),
    ).toHaveLength(1);
    const serialized = JSON.stringify(queries);
    expect(serialized).toContain(evidence.promptRef);
    expect(serialized).toContain(evidence.outputRef);
    expect(serialized).not.toContain('synthetic source note');
  });
});
