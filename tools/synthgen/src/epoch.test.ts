import { describe, expect, it } from 'vitest';
import { computeManifestCheckpoint } from '@practicehub/testkit';

import {
  RecoveryEpochFenceError,
  assertReplayFenced,
  buildCorpusSideEffect,
  corpusEffectIdempotencyKey,
  duplicateSideEffectsOnReplay,
  planCorpusReplay,
  type ReplayLedgerEntry,
} from './epoch.js';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    synthetic: true,
    corpus_version: 'SynthCorpus-v1',
    recovery_epoch: 'RE-001',
    ...overrides,
  };
  return { ...base, manifest_checkpoint: computeManifestCheckpoint(base) };
}

const effects = [
  buildCorpusSideEffect('SynthCorpus-v1', 'corpus-subject-seeded', 'sg-p-0001'),
  buildCorpusSideEffect('SynthCorpus-v1', 'corpus-household-seeded', 'sg-hh-0001'),
];

const landed: ReplayLedgerEntry = {
  delivery: { status: 'published', attempts: 1 },
  alreadyConsumed: true,
};

describe('corpus effect keys', () => {
  it('are EPOCH-INDEPENDENT — the property the whole invariant rests on', () => {
    // Same corpus version and entity, two different restores: one key. If the
    // epoch were folded in, a restore would mint a new key for an effect that
    // already landed and re-fire it.
    const first = corpusEffectIdempotencyKey(
      'SynthCorpus-v1',
      'corpus-subject-seeded',
      'sg-p-0001',
    );
    const second = corpusEffectIdempotencyKey(
      'SynthCorpus-v1',
      'corpus-subject-seeded',
      'sg-p-0001',
    );
    expect(first).toBe(second);
    expect(first).not.toContain('RE-');
  });

  it('separate corpus versions, kinds, and entities', () => {
    const base = corpusEffectIdempotencyKey('SynthCorpus-v1', 'corpus-subject-seeded', 'sg-p-0001');
    expect(base).not.toBe(
      corpusEffectIdempotencyKey('SynthCorpus-v2', 'corpus-subject-seeded', 'sg-p-0001'),
    );
    expect(base).not.toBe(
      corpusEffectIdempotencyKey('SynthCorpus-v1', 'corpus-household-seeded', 'sg-p-0001'),
    );
    expect(base).not.toBe(
      corpusEffectIdempotencyKey('SynthCorpus-v1', 'corpus-subject-seeded', 'sg-p-0002'),
    );
  });

  it('refuse empty inputs', () => {
    expect(() => corpusEffectIdempotencyKey('', 'corpus-subject-seeded', 'x')).toThrow();
    expect(() => corpusEffectIdempotencyKey('v', 'corpus-subject-seeded', '')).toThrow();
  });
});

describe('recovery-epoch fence', () => {
  it('accepts a manifest whose checkpoint recomputes', () => {
    expect(assertReplayFenced(manifest())).toHaveLength(64);
  });

  it('REFUSES a restore whose checkpoint does not recompute', () => {
    const tampered = { ...manifest(), corpus_version: 'SynthCorpus-tampered' };
    expect(() => assertReplayFenced(tampered)).toThrow(RecoveryEpochFenceError);
    expect(() => assertReplayFenced(tampered)).toThrow(/does not recompute/);
  });

  it('refuses a manifest with no checkpoint at all', () => {
    expect(() => assertReplayFenced({ synthetic: true })).toThrow(/no manifest_checkpoint/);
  });
});

describe('planCorpusReplay', () => {
  it('emits NO duplicate side effect when every effect already landed', () => {
    const ledger = new Map(effects.map((effect) => [effect.idempotencyKey, landed]));
    const plan = planCorpusReplay(manifest(), 'RE-001', effects, ledger);
    expect(duplicateSideEffectsOnReplay(plan)).toEqual([]);
    expect(plan.fenced).toHaveLength(effects.length);
  });

  it('fences ACROSS an epoch boundary — effects landed under RE-000, replayed under RE-001', () => {
    const ledger = new Map(effects.map((effect) => [effect.idempotencyKey, landed]));
    const plan = planCorpusReplay(
      manifest({ recovery_epoch: 'RE-000' }),
      'RE-001',
      effects,
      ledger,
    );
    expect(plan.resend).toEqual([]);
    expect(plan.recoveryEpoch).toBe('RE-001');
  });

  it('fences a dead-lettered effect too — terminal is terminal, never re-sent', () => {
    const ledger = new Map(
      effects.map((effect) => [
        effect.idempotencyKey,
        { delivery: { status: 'dead' as const, attempts: 5 }, alreadyConsumed: false },
      ]),
    );
    expect(planCorpusReplay(manifest(), 'RE-001', effects, ledger).resend).toEqual([]);
  });

  it('an effect whose delivery never produced one IS resendable', () => {
    const ledger = new Map(
      effects.map((effect) => [
        effect.idempotencyKey,
        { delivery: { status: 'pending' as const, attempts: 0 }, alreadyConsumed: false },
      ]),
    );
    const plan = planCorpusReplay(manifest(), 'RE-001', effects, ledger);
    expect(plan.resend).toHaveLength(effects.length);
    expect(plan.fenced).toEqual([]);
  });

  it('an effect with no ledger entry at all is resendable — it demonstrably never fired', () => {
    const plan = planCorpusReplay(manifest(), 'RE-001', effects, new Map());
    expect(plan.resend).toHaveLength(effects.length);
  });

  it('a consumed-but-unpublished effect is still fenced (inbox evidence wins)', () => {
    const ledger = new Map(
      effects.map((effect) => [
        effect.idempotencyKey,
        { delivery: { status: 'failed' as const, attempts: 2 }, alreadyConsumed: true },
      ]),
    );
    expect(planCorpusReplay(manifest(), 'RE-001', effects, ledger).resend).toEqual([]);
  });

  it('refuses to plan at all when the checkpoint does not verify', () => {
    const ledger = new Map(effects.map((effect) => [effect.idempotencyKey, landed]));
    expect(() =>
      planCorpusReplay({ ...manifest(), recovery_epoch: 'RE-999' }, 'RE-999', effects, ledger),
    ).toThrow(RecoveryEpochFenceError);
  });

  it('every built effect carries the watermark and a stable derived key', () => {
    for (const effect of effects) {
      expect(effect.synthetic).toBe(true);
      expect(effect.effectKey).toHaveLength(32);
    }
    expect(buildCorpusSideEffect('SynthCorpus-v1', 'corpus-subject-seeded', 'sg-p-0001')).toEqual(
      effects[0],
    );
  });
});
