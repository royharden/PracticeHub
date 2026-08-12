/**
 * Sim state store (WP-027). Contract: docs/contracts/vendor-sim-scenario-api.md
 * (FROZEN) §5. The store is the simulator's effect LEDGER — one record per
 * (rail, idempotency key) — plus the receipts a rail has emitted.
 *
 * PHI-free BY CONSTRUCTION, three ways (the WP-024 content-addressing lesson):
 *   - `SimEffectRecord` has NO field that can hold a payload value; the
 *     dispatcher hashes the request payload and discards the bytes;
 *   - every ref-shaped field is ref-grammar constrained, so prose (and therefore
 *     a smuggled value) is unrepresentable;
 *   - every record carries the literal `synthetic: true` watermark and the store
 *     REFUSES a record without it.
 *
 * Durability is the process-kill contract: `FileSimStateStore` persists
 * atomically (temp file + rename) on every write, so a killed process leaves the
 * ledger exactly as of its last write — which is what makes "no duplicate
 * external effect across a crash" provable rather than asserted.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { railIdPattern } from '@practicehub/platform-integration';

/** The WP-020 audit ref grammar: lower-case ids, no prose, no free text. */
export const simRefPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const payloadHashPattern = /^[0-9a-f]{64}$/;
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export const simEffectStates = ['landed', 'partial', 'unknown', 'not-landed'] as const;
export type SimEffectState = (typeof simEffectStates)[number];

export const simReceiptKinds = [
  'primary',
  'duplicate',
  'late',
  'corrected',
  'reversal',
  'partial',
] as const;
export type SimReceiptKind = (typeof simReceiptKinds)[number];

export interface SimEffectRecord {
  readonly railId: string;
  readonly operation: string;
  readonly effectKey: string;
  readonly idempotencyKey: string;
  /** sha-256 of the canonicalized request payload; the bytes are never stored. */
  readonly payloadHash: string;
  readonly receiptRef: string | null;
  readonly state: SimEffectState;
  readonly attempts: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly synthetic: true;
}

export interface SimReceipt {
  readonly receiptRef: string;
  readonly railId: string;
  readonly effectKey: string;
  readonly idempotencyKey: string;
  readonly kind: SimReceiptKind;
  /** Emission order as the RAIL produced it (out-of-order injection reverses the drain, not this). */
  readonly sequence: number;
  readonly supersedesRef: string | null;
  readonly reversesRef: string | null;
  readonly fenceCrossed: boolean;
  readonly emittedAt: string;
  readonly synthetic: true;
}

/**
 * An idle liveness tick (WP-028). A rail that emits these distinguishes "quiet"
 * from "gone"; the record carries counts and ids only, so the store's PHI-free
 * posture extends to the heartbeat surface by construction.
 */
export interface SimHeartbeat {
  readonly railId: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly synthetic: true;
}

export interface SimStateSnapshot {
  readonly effects: readonly SimEffectRecord[];
  readonly receipts: readonly SimReceipt[];
  readonly heartbeats: readonly SimHeartbeat[];
  readonly synthetic: true;
}

export class SimStateStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SimStateStoreError';
  }
}

function assertRailId(value: string): void {
  if (!railIdPattern.test(value)) {
    throw new SimStateStoreError(`railId ${JSON.stringify(value)} is not a RAIL-### id`);
  }
}

function assertRef(label: string, value: string): void {
  if (!simRefPattern.test(value)) {
    throw new SimStateStoreError(
      `${label} ${JSON.stringify(value)} is not ref-grammar (a sim store holds refs, never values)`,
    );
  }
}

function assertInstant(label: string, value: string): void {
  if (!isoInstantPattern.test(value)) {
    throw new SimStateStoreError(`${label} ${JSON.stringify(value)} is not an ISO instant`);
  }
}

/** Validate a ledger record before it can enter any store binding. */
export function assertSimEffectRecord(record: SimEffectRecord): void {
  if (record.synthetic !== true) {
    throw new SimStateStoreError('a sim effect record without the synthetic watermark is refused');
  }
  assertRailId(record.railId);
  assertRef('operation', record.operation);
  assertRef('effectKey', record.effectKey);
  assertRef('idempotencyKey', record.idempotencyKey);
  if (!payloadHashPattern.test(record.payloadHash)) {
    throw new SimStateStoreError(
      'payloadHash must be a sha-256 hex digest — a sim store never holds payload bytes',
    );
  }
  if (record.receiptRef !== null) {
    assertRef('receiptRef', record.receiptRef);
  }
  if (!(simEffectStates as readonly string[]).includes(record.state)) {
    throw new SimStateStoreError(`unknown effect state ${JSON.stringify(record.state)}`);
  }
  if (!Number.isInteger(record.attempts) || record.attempts < 1) {
    throw new SimStateStoreError('attempts must be a positive integer');
  }
  assertInstant('firstSeenAt', record.firstSeenAt);
  assertInstant('lastSeenAt', record.lastSeenAt);
}

export function assertSimReceipt(receipt: SimReceipt): void {
  if (receipt.synthetic !== true) {
    throw new SimStateStoreError('a sim receipt without the synthetic watermark is refused');
  }
  assertRef('receiptRef', receipt.receiptRef);
  assertRailId(receipt.railId);
  assertRef('effectKey', receipt.effectKey);
  assertRef('idempotencyKey', receipt.idempotencyKey);
  if (!(simReceiptKinds as readonly string[]).includes(receipt.kind)) {
    throw new SimStateStoreError(`unknown receipt kind ${JSON.stringify(receipt.kind)}`);
  }
  if (receipt.supersedesRef !== null) {
    assertRef('supersedesRef', receipt.supersedesRef);
  }
  if (receipt.reversesRef !== null) {
    assertRef('reversesRef', receipt.reversesRef);
  }
  assertInstant('emittedAt', receipt.emittedAt);
}

export function assertSimHeartbeat(heartbeat: SimHeartbeat): void {
  if (heartbeat.synthetic !== true) {
    throw new SimStateStoreError('a sim heartbeat without the synthetic watermark is refused');
  }
  assertRailId(heartbeat.railId);
  if (!Number.isInteger(heartbeat.sequence) || heartbeat.sequence < 1) {
    throw new SimStateStoreError('heartbeat sequence must be a positive integer');
  }
  assertInstant('recordedAt', heartbeat.recordedAt);
}

/** Canonical JSON (stable key order) so a payload hash is reproducible. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

export interface SimStateStore {
  readEffect(railId: string, idempotencyKey: string): SimEffectRecord | undefined;
  writeEffect(record: SimEffectRecord): void;
  listEffects(): readonly SimEffectRecord[];
  appendReceipts(receipts: readonly SimReceipt[]): void;
  /** Remove and return the pending receipts for a rail, in emission order. */
  drainReceipts(railId: string): readonly SimReceipt[];
  listReceipts(): readonly SimReceipt[];
  /** Record one idle liveness tick for a rail (WP-028 heartbeat modeling). */
  recordHeartbeat(railId: string, recordedAt: string): SimHeartbeat;
  listHeartbeats(): readonly SimHeartbeat[];
  snapshot(): SimStateSnapshot;
  reset(): void;
}

const effectKeyOf = (railId: string, idempotencyKey: string): string =>
  `${railId}\u0000${idempotencyKey}`;

export class InMemorySimStateStore implements SimStateStore {
  protected effects = new Map<string, SimEffectRecord>();
  protected receipts: SimReceipt[] = [];
  protected heartbeats: SimHeartbeat[] = [];

  public readEffect(railId: string, idempotencyKey: string): SimEffectRecord | undefined {
    return this.effects.get(effectKeyOf(railId, idempotencyKey));
  }

  public writeEffect(record: SimEffectRecord): void {
    assertSimEffectRecord(record);
    this.effects.set(effectKeyOf(record.railId, record.idempotencyKey), record);
    this.persist();
  }

  public listEffects(): readonly SimEffectRecord[] {
    return [...this.effects.values()].sort((left, right) =>
      effectKeyOf(left.railId, left.idempotencyKey).localeCompare(
        effectKeyOf(right.railId, right.idempotencyKey),
      ),
    );
  }

  public appendReceipts(receipts: readonly SimReceipt[]): void {
    for (const receipt of receipts) {
      assertSimReceipt(receipt);
    }
    this.receipts.push(...receipts);
    this.persist();
  }

  public drainReceipts(railId: string): readonly SimReceipt[] {
    const drained = this.receipts.filter((receipt) => receipt.railId === railId);
    this.receipts = this.receipts.filter((receipt) => receipt.railId !== railId);
    this.persist();
    return drained;
  }

  public listReceipts(): readonly SimReceipt[] {
    return [...this.receipts];
  }

  public recordHeartbeat(railId: string, recordedAt: string): SimHeartbeat {
    const sequence = this.heartbeats.filter((heartbeat) => heartbeat.railId === railId).length + 1;
    const heartbeat: SimHeartbeat = { railId, sequence, recordedAt, synthetic: true };
    assertSimHeartbeat(heartbeat);
    this.heartbeats.push(heartbeat);
    this.persist();
    return heartbeat;
  }

  public listHeartbeats(): readonly SimHeartbeat[] {
    return [...this.heartbeats];
  }

  public snapshot(): SimStateSnapshot {
    return {
      effects: this.listEffects(),
      receipts: this.listReceipts(),
      heartbeats: this.listHeartbeats(),
      synthetic: true,
    };
  }

  public reset(): void {
    this.effects.clear();
    this.receipts = [];
    this.heartbeats = [];
    this.persist();
  }

  /** In-memory stores have nothing to persist; the file binding overrides this. */
  protected persist(): void {
    return;
  }
}

/**
 * File-backed ledger: the durability half of the process-kill contract. Writes
 * are atomic (temp file + rename), so a hard kill mid-write can never leave a
 * torn ledger, and a restart reads exactly what was committed before the death.
 */
export class FileSimStateStore extends InMemorySimStateStore {
  private loading = false;

  public constructor(private readonly path: string) {
    super();
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) {
      return;
    }
    this.loading = true;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<SimStateSnapshot>;
      for (const record of raw.effects ?? []) {
        assertSimEffectRecord(record);
        this.effects.set(effectKeyOf(record.railId, record.idempotencyKey), record);
      }
      const receipts = raw.receipts ?? [];
      for (const receipt of receipts) {
        assertSimReceipt(receipt);
      }
      this.receipts = [...receipts];
      const heartbeats = raw.heartbeats ?? [];
      for (const heartbeat of heartbeats) {
        assertSimHeartbeat(heartbeat);
      }
      this.heartbeats = [...heartbeats];
    } finally {
      this.loading = false;
    }
  }

  protected override persist(): void {
    if (this.loading) {
      return;
    }
    const directory = dirname(this.path);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
    const temporary = `${this.path}.writing`;
    writeFileSync(temporary, `${JSON.stringify(this.snapshot(), null, 2)}\n`, 'utf8');
    renameSync(temporary, this.path);
  }
}
