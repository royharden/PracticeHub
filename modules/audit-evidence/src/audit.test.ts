/**
 * Unit suite for the audit store core (WP-020 gate surface): emit validation
 * (PHI-safe by construction), hash-chain determinism + tamper evidence
 * (R6-REQ-001), same-commit coupling, deny mapping, export with partition-tag
 * survival, and the R6-REQ-102 AI round-trip.
 */
import { describe, expect, it } from 'vitest';

import type { AuthorityDecision } from '@practicehub/platform-core';

import {
  auditInputForAuthorityDecision,
  auditTrailForSubject,
  emitAuditEvent,
  emptyChainState,
  exportAuditSlice,
  genesisHash,
  reconstructAiInteractions,
  runAuditedOperation,
  validateAuditEmitInput,
  verifyAuditChain,
  type AuditChainState,
  type AuditEmitInput,
  type AuditRecord,
} from './audit.js';

const tenant = 'northwind-synthetic';
const sha = (fill: string): string => fill.repeat(64 / fill.length);

function accessInput(overrides: Partial<AuditEmitInput> = {}): AuditEmitInput {
  return {
    auditId: 'ta-0001',
    tenantId: tenant,
    stream: 'access',
    action: 'chart-view',
    actorRef: 'synthetic-staff:tester-001',
    occurredAt: '2026-03-20T09:00:00Z',
    subjectRef: 'np-test-subject',
    decision: 'allow',
    reason: 'treatment',
    synthetic: true,
    ...overrides,
  };
}

function aiInput(overrides: Partial<AuditEmitInput> = {}): AuditEmitInput {
  return {
    auditId: 'ta-ai-0001',
    tenantId: tenant,
    stream: 'ai-interaction',
    action: 'draft-message',
    actorRef: 'synthetic-staff:tester-001',
    occurredAt: '2026-03-20T09:10:00Z',
    subjectRef: 'np-test-subject',
    modelRef: 'model-sim:claude-sonnet',
    modelVersion: 'claude-sonnet-5-synthetic',
    promptRef: 'minio://synthetic-ai/prompts/t-0001',
    promptHash: sha('ab'),
    outputRef: 'minio://synthetic-ai/outputs/t-0001',
    outputHash: sha('cd'),
    synthetic: true,
    ...overrides,
  };
}

function emitAll(inputs: readonly AuditEmitInput[]): {
  state: AuditChainState;
  records: AuditRecord[];
} {
  let state: AuditChainState = emptyChainState;
  const records: AuditRecord[] = [];
  for (const input of inputs) {
    const emitted = emitAuditEvent(state, input);
    state = emitted.state;
    records.push(emitted.record);
  }
  return { state, records };
}

describe('audit.emit validation (PHI-safe by construction)', () => {
  it('accepts a complete access record, allow and deny alike', () => {
    expect(() => validateAuditEmitInput(accessInput())).not.toThrow();
    expect(() =>
      validateAuditEmitInput(accessInput({ decision: 'deny', reason: 'operations' })),
    ).not.toThrow();
  });

  it('an access record without subject, decision, or reason is refused', () => {
    for (const missing of ['subjectRef', 'decision', 'reason'] as const) {
      const input = Object.fromEntries(
        Object.entries(accessInput()).filter(([key]) => key !== missing),
      ) as unknown as AuditEmitInput;
      expect(() => validateAuditEmitInput(input), missing).toThrow(missing);
    }
  });

  it('an AI interaction without model version (or any ref/hash pair) is refused — R6-REQ-102', () => {
    for (const missing of [
      'modelRef',
      'modelVersion',
      'promptRef',
      'promptHash',
      'outputRef',
      'outputHash',
      'subjectRef',
    ] as const) {
      const input = Object.fromEntries(
        Object.entries(aiInput()).filter(([key]) => key !== missing),
      ) as unknown as AuditEmitInput;
      expect(() => validateAuditEmitInput(input), missing).toThrow(missing);
    }
  });

  it('free text is refused everywhere a value could carry PHI', () => {
    // Prose in a detail value (spaces, capitals) — the ref grammar refuses it.
    expect(() =>
      validateAuditEmitInput(
        accessInput({ detail: { note: 'Patient Sam Porter called about labs' } }),
      ),
    ).toThrow('never prose or raw values');
    // A reason outside the closed vocabulary.
    expect(() =>
      validateAuditEmitInput(accessInput({ reason: 'looked because curious' as never })),
    ).toThrow('closed vocabulary');
    // Prose actor.
    expect(() => validateAuditEmitInput(accessInput({ actorRef: 'Dr Morgan Lee' }))).toThrow(
      'never prose or raw values',
    );
  });

  it('hashes must be sha-256 hex; instants must be whole-second UTC', () => {
    expect(() => validateAuditEmitInput(aiInput({ promptHash: 'not-a-hash' }))).toThrow('sha-256');
    expect(() =>
      validateAuditEmitInput(accessInput({ occurredAt: '2026-03-20T09:00:00.123Z' })),
    ).toThrow('whole-second');
    expect(() =>
      validateAuditEmitInput(accessInput({ occurredAt: '2026-03-20 09:00:00' })),
    ).toThrow('whole-second');
  });

  it('per-stream pointers are required: consent mirror, capability transition, config change', () => {
    const base = {
      auditId: 'ta-0002',
      tenantId: tenant,
      actorRef: 'synthetic-staff:tester-001',
      occurredAt: '2026-03-20T09:00:00Z',
      synthetic: true,
    } as const;
    expect(() =>
      validateAuditEmitInput({ ...base, stream: 'consent-event', action: 'consent-recorded' }),
    ).toThrow('correlationRef');
    expect(() =>
      validateAuditEmitInput({
        ...base,
        stream: 'capability-transition',
        action: 'capability-transition-recorded',
      }),
    ).toThrow('correlationRef');
    expect(() =>
      validateAuditEmitInput({ ...base, stream: 'config-change', action: 'config-updated' }),
    ).toThrow('detail.config_ref');
  });

  it('the synthetic watermark and known partition tags are mandatory', () => {
    expect(() =>
      validateAuditEmitInput(accessInput({ synthetic: false as unknown as true })),
    ).toThrow('synthetic');
    expect(() =>
      validateAuditEmitInput(accessInput({ partitionTags: ['secret-club' as never] })),
    ).toThrow('partition tag');
  });
});

describe('hash chain per tenant-day (R6-REQ-001 tamper evidence)', () => {
  const inputs: AuditEmitInput[] = [
    accessInput({ auditId: 'tc-0001', occurredAt: '2026-03-20T09:00:00Z' }),
    accessInput({ auditId: 'tc-0002', occurredAt: '2026-03-20T10:00:00Z', decision: 'deny' }),
    accessInput({ auditId: 'tc-0003', occurredAt: '2026-03-21T09:00:00Z' }),
    accessInput({ auditId: 'tc-0004', tenantId: 'riverbend-synthetic' }),
  ];

  it('is deterministic and links seq/prev per tenant-day', () => {
    const first = emitAll(inputs);
    const second = emitAll(inputs);
    expect(first.records).toEqual(second.records);
    const [a, b, c, d] = first.records as [AuditRecord, AuditRecord, AuditRecord, AuditRecord];
    expect([a.chainSeq, a.prevHash]).toEqual([1, genesisHash]);
    expect([b.chainSeq, b.prevHash]).toEqual([2, a.entryHash]);
    // A new day and a different tenant each open their own chain at genesis.
    expect([c.chainSeq, c.prevHash]).toEqual([1, genesisHash]);
    expect([d.chainSeq, d.prevHash]).toEqual([1, genesisHash]);
  });

  it('verifies clean and names every tamper class at its sequence', () => {
    const { records } = emitAll(inputs);
    expect(verifyAuditChain(records)).toMatchObject({ valid: true, chains: 3, breaks: [] });

    // Edit any hashed field mid-chain -> hash-mismatch at that seq.
    const edited = records.map((record) =>
      record.auditId === 'tc-0001' ? { ...record, actorRef: 'synthetic-staff:forged' } : record,
    );
    expect(verifyAuditChain(edited).breaks).toEqual([
      { chainKey: `${tenant}|2026-03-20`, chainSeq: 1, reason: 'hash-mismatch' },
    ]);

    // Remove a link -> gap.
    const removed = records.filter((record) => record.auditId !== 'tc-0001');
    expect(verifyAuditChain(removed).breaks).toEqual([
      { chainKey: `${tenant}|2026-03-20`, chainSeq: 2, reason: 'gap' },
    ]);

    // Forge the link -> link-mismatch.
    const relinked = records.map((record) =>
      record.auditId === 'tc-0002' ? { ...record, prevHash: sha('ef') } : record,
    );
    expect(verifyAuditChain(relinked).breaks[0]?.reason).toBe('link-mismatch');

    // Forge a genesis -> genesis-mismatch.
    const forgedGenesis = records.map((record) =>
      record.auditId === 'tc-0003' ? { ...record, prevHash: sha('ab') } : record,
    );
    expect(verifyAuditChain(forgedGenesis).breaks[0]?.reason).toBe('genesis-mismatch');
  });

  it('detail values and partition tags are inside the hashed surface', () => {
    const { records } = emitAll([
      accessInput({ auditId: 'tc-0005', partitionTags: ['gipa-genetic'], detail: { k: 'v1' } }),
    ]);
    const tamperedDetail = [{ ...(records[0] as AuditRecord), detail: { k: 'v2' } }];
    expect(verifyAuditChain(tamperedDetail).breaks[0]?.reason).toBe('hash-mismatch');
    const tamperedTags = [{ ...(records[0] as AuditRecord), partitionTags: [] as never[] }];
    expect(verifyAuditChain(tamperedTags).breaks[0]?.reason).toBe('hash-mismatch');
  });
});

describe('same-commit coupling (contract decision 3)', () => {
  it('operation and audit record are only observable together', () => {
    const outcome = runAuditedOperation(emptyChainState, accessInput(), () => 'op-result');
    expect(outcome.result).toBe('op-result');
    expect(outcome.record.chainSeq).toBe(1);
    expect(outcome.state.size).toBe(1);
  });

  it('a failing operation yields nothing — the caller keeps the prior chain state', () => {
    expect(() =>
      runAuditedOperation(emptyChainState, accessInput(), () => {
        throw new Error('synthetic operation crash');
      }),
    ).toThrow('synthetic operation crash');
  });

  it('an unauditable operation never runs — fail closed', () => {
    const unauditable = Object.fromEntries(
      Object.entries(accessInput()).filter(([key]) => key !== 'reason'),
    ) as unknown as AuditEmitInput;
    let ran = false;
    expect(() =>
      runAuditedOperation(emptyChainState, unauditable, () => {
        ran = true;
      }),
    ).toThrow('reason');
    expect(ran).toBe(false);
  });
});

describe('authority-decision mapping (FWD-AUD-015-PDP shape)', () => {
  const decisionFor = (allowed: boolean): AuthorityDecision => ({
    capabilityId: 'platform.audit-store',
    tenantId: tenant,
    grantState: allowed ? 'simulated' : 'scaffolded',
    grantScope: {},
    grantScopeKey: '{}',
    sinceEventId: 'synthetic-cap-evt-0011',
    allowed,
    reason: 'prose stays in the source system',
    minimumState: 'simulated',
    checkpoint: 'drain',
  });

  it('allow and deny both map to valid emit inputs — a deny cannot be dropped', () => {
    for (const allowed of [true, false]) {
      const input = auditInputForAuthorityDecision(decisionFor(allowed), {
        auditId: allowed ? 'tad-0001' : 'tad-0002',
        actorRef: 'synthetic-staff:tester-001',
        occurredAt: '2026-03-20T09:00:00Z',
      });
      expect(() => validateAuditEmitInput(input)).not.toThrow();
      expect(input.decision).toBe(allowed ? 'allow' : 'deny');
      expect(input.detail?.['capability_id']).toBe('platform.audit-store');
      expect(input.detail?.['checkpoint']).toBe('drain');
      // The decision's prose reason is NOT carried — machine fields only.
      expect(JSON.stringify(input)).not.toContain('prose stays');
    }
  });
});

describe('export with partition-tag survival (R6-REQ-001 exportability)', () => {
  it('exports a subject slice, audits the export, and carries the tags through', () => {
    const { state, records } = emitAll([
      accessInput({ auditId: 'te-0001', partitionTags: ['gipa-genetic'] }),
      accessInput({ auditId: 'te-0002', subjectRef: 'np-other-subject' }),
      aiInput({ auditId: 'te-0003' }),
    ]);
    const slice = exportAuditSlice(records, {
      exportAuditId: 'te-export-0001',
      tenantId: tenant,
      requestedBy: 'synthetic-staff:compliance-001',
      recipientRef: 'synthetic-recipient:ocr-request-0001',
      purpose: 'investigation',
      occurredAt: '2026-03-20T12:00:00Z',
      subjectRef: 'np-test-subject',
    });
    expect(slice.records.map((record) => record.auditId)).toEqual(['te-0001', 'te-0003']);
    expect(slice.partitionTags).toEqual(['gipa-genetic']);
    expect(slice.chainHeads.length).toBeGreaterThan(0);
    expect(slice.exportAuditInput.stream).toBe('disclosure');
    expect(slice.exportAuditInput.recipientRef).toBe('synthetic-recipient:ocr-request-0001');
    expect(slice.exportAuditInput.purpose).toBe('investigation');
    expect(slice.exportAuditInput.partitionTags).toEqual(['gipa-genetic']);
    // The export audit record chains cleanly onto the same store.
    const emitted = emitAuditEvent(state, slice.exportAuditInput);
    expect(verifyAuditChain([...records, emitted.record]).valid).toBe(true);
  });
});

describe('AI interaction round-trip (R6-REQ-102)', () => {
  it('reconstructs per subject with model + version on every row', () => {
    const { records } = emitAll([
      aiInput({ auditId: 'tr-0001', occurredAt: '2026-03-20T09:10:00Z' }),
      aiInput({
        auditId: 'tr-0002',
        occurredAt: '2026-03-20T09:20:00Z',
        subjectRef: 'np-other-subject',
      }),
      aiInput({ auditId: 'tr-0003', occurredAt: '2026-03-20T09:30:00Z' }),
      accessInput({ auditId: 'tr-0004' }),
    ]);
    const reconstruction = reconstructAiInteractions(records, tenant, 'np-test-subject');
    expect(reconstruction.map((row) => row.auditId)).toEqual(['tr-0001', 'tr-0003']);
    for (const row of reconstruction) {
      expect(row.modelRef).toBe('model-sim:claude-sonnet');
      expect(row.modelVersion).toBe('claude-sonnet-5-synthetic');
      expect(row.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.outputHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('the retained trail is retrievable by subject (R6-REQ-052 slice)', () => {
    const { records } = emitAll([
      accessInput({ auditId: 'tt-0002', occurredAt: '2026-03-20T10:00:00Z' }),
      accessInput({ auditId: 'tt-0001', occurredAt: '2026-03-20T09:00:00Z' }),
      accessInput({ auditId: 'tt-0003', subjectRef: 'np-other-subject' }),
    ]);
    expect(auditTrailForSubject(records, tenant, 'np-test-subject').map((r) => r.auditId)).toEqual([
      'tt-0001',
      'tt-0002',
    ]);
  });
});
