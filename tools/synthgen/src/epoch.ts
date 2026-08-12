/**
 * Recovery epochs and corpus replay (WP-029 verification gate, clause 4:
 * "checkpoint replay emits no duplicate side effect").
 *
 * ARCHITECTURE.md: "restores are fenced by manifest checkpoints; no duplicate
 * external sends on replay." The corpus is the thing being restored, so this is
 * where that invariant becomes executable.
 *
 * Two rules, and the second is the one that actually bites:
 *
 * 1. A replay is admissible only inside a VERIFIED checkpoint. A restore whose
 *    manifest checkpoint does not recompute is refused outright — a corpus that
 *    cannot prove what it is does not get to re-emit anything.
 *
 * 2. A corpus effect's idempotency key is derived from the corpus VERSION and
 *    the entity, and DELIBERATELY NOT from the recovery epoch. That is the
 *    whole point. If the epoch were in the key, reseeding under a new epoch
 *    would mint fresh keys, every already-landed effect would look new, and the
 *    restore would re-fire the lot — which is precisely the duplicate-send
 *    failure the epoch model exists to prevent. Keying across the boundary is
 *    what lets the WP-021 recovery fence recognise the effect it already saw.
 *
 * The fence decision itself is NOT reimplemented here: it is
 * `recoveryFenceDecision` from @practicehub/platform (WP-021), reused so there
 * is one replay model in the build rather than a corpus-flavoured second one.
 */
import { recoveryFenceDecision, type OutboxDelivery } from '@practicehub/platform';
import { computeManifestCheckpoint, sha256Hex } from '@practicehub/testkit';
import type { SynthCorpusManifest } from '@practicehub/testkit';

export type CorpusEffectKind = 'corpus-subject-seeded' | 'corpus-household-seeded';

export interface CorpusSideEffect {
  readonly effectKey: string;
  readonly kind: CorpusEffectKind;
  readonly entityRef: string;
  readonly idempotencyKey: string;
  readonly synthetic: true;
}

/**
 * Idempotency key for a corpus side effect. Epoch-INDEPENDENT by construction —
 * see rule 2 above. Changing the corpus VERSION does mint new keys, which is
 * correct: a different corpus version is a different world, and its effects are
 * genuinely new.
 */
export function corpusEffectIdempotencyKey(
  corpusVersion: string,
  kind: CorpusEffectKind,
  entityRef: string,
): string {
  if (corpusVersion.length === 0 || entityRef.length === 0) {
    throw new Error('corpusEffectIdempotencyKey: corpusVersion and entityRef are required');
  }
  return `corpus:${corpusVersion}:${kind}:${entityRef}`;
}

export function buildCorpusSideEffect(
  corpusVersion: string,
  kind: CorpusEffectKind,
  entityRef: string,
): CorpusSideEffect {
  const idempotencyKey = corpusEffectIdempotencyKey(corpusVersion, kind, entityRef);
  return {
    effectKey: sha256Hex(idempotencyKey).slice(0, 32),
    kind,
    entityRef,
    idempotencyKey,
    synthetic: true,
  };
}

export class RecoveryEpochFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryEpochFenceError';
  }
}

/**
 * Refuse a replay whose manifest checkpoint does not verify. `manifest` is the
 * raw document (checkpoint included) so the recompute is over exactly what is
 * on disk, not over a re-serialised copy of a parsed object.
 */
export function assertReplayFenced(rawManifest: Record<string, unknown>): string {
  const recorded = rawManifest.manifest_checkpoint;
  if (typeof recorded !== 'string' || recorded.length === 0) {
    throw new RecoveryEpochFenceError(
      'replay refused: the corpus manifest carries no manifest_checkpoint to fence the restore',
    );
  }
  const computed = computeManifestCheckpoint(rawManifest);
  if (computed !== recorded) {
    throw new RecoveryEpochFenceError(
      `replay refused: manifest_checkpoint ${recorded} does not recompute (${computed}) — ` +
        'an unfenced restore may not re-emit corpus effects',
    );
  }
  return computed;
}

export interface ReplayLedgerEntry {
  readonly delivery: OutboxDelivery;
  readonly alreadyConsumed: boolean;
}

export interface CorpusReplayPlan {
  /** Idempotency keys whose effect has NOT landed and may be emitted. */
  readonly resend: readonly string[];
  /** Idempotency keys the fence resolved to no-resend (already landed). */
  readonly fenced: readonly string[];
  /** The checkpoint the replay ran under. */
  readonly checkpoint: string;
  /** Epoch the restore lands in; carried for the receipt, never for the key. */
  readonly recoveryEpoch: string;
}

/**
 * Plan a corpus replay after a restore. Every effect whose delivery already
 * published, dead-lettered, or was consumed downstream is fenced; only an
 * effect that never produced one is resendable.
 *
 * An effect with NO ledger entry at all is resendable — it has demonstrably
 * never been emitted. An effect with an entry is decided by the WP-021 fence.
 */
export function planCorpusReplay(
  rawManifest: Record<string, unknown>,
  recoveryEpoch: string,
  effects: readonly CorpusSideEffect[],
  ledger: ReadonlyMap<string, ReplayLedgerEntry>,
): CorpusReplayPlan {
  const checkpoint = assertReplayFenced(rawManifest);
  const resend: string[] = [];
  const fenced: string[] = [];

  for (const effect of effects) {
    const entry = ledger.get(effect.idempotencyKey);
    if (!entry) {
      resend.push(effect.idempotencyKey);
      continue;
    }
    if (recoveryFenceDecision(entry.delivery, entry.alreadyConsumed) === 'reconciled-no-resend') {
      fenced.push(effect.idempotencyKey);
    } else {
      resend.push(effect.idempotencyKey);
    }
  }

  return { resend, fenced, checkpoint, recoveryEpoch };
}

/**
 * The gate assertion: replaying a corpus whose effects ALL landed under a prior
 * epoch must plan zero resends. Returns the offending keys so a failure names
 * what would have been duplicated rather than merely reporting a count.
 */
export function duplicateSideEffectsOnReplay(plan: CorpusReplayPlan): readonly string[] {
  return plan.resend;
}

export function manifestRecoveryEpoch(manifest: SynthCorpusManifest): string {
  return manifest.recovery_epoch;
}
