import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalJson,
  hashPayload,
  FileSimStateStore,
  InMemorySimStateStore,
  SimStateStoreError,
  type SimEffectRecord,
  type SimReceipt,
} from './store.js';

const record: SimEffectRecord = {
  railId: 'RAIL-008',
  operation: 'payment-intent',
  effectKey: 'synthetic:tenant/payment-intent/0001',
  idempotencyKey: 'synthetic-idem-0001',
  payloadHash: hashPayload({ amount: 1 }),
  receiptRef: 'synthetic:tenant/payment-intent/0001:r1',
  state: 'landed',
  attempts: 1,
  firstSeenAt: '2026-01-01T00:00:00Z',
  lastSeenAt: '2026-01-01T00:00:00Z',
  synthetic: true,
};

const receipt: SimReceipt = {
  receiptRef: 'synthetic:tenant/payment-intent/0001:r1',
  railId: 'RAIL-008',
  effectKey: 'synthetic:tenant/payment-intent/0001',
  idempotencyKey: 'synthetic-idem-0001',
  kind: 'primary',
  sequence: 1,
  supersedesRef: null,
  reversesRef: null,
  fenceCrossed: false,
  emittedAt: '2026-01-01T00:00:00Z',
  synthetic: true,
};

const temporaryDirectories: string[] = [];

function temporaryStatePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'vendor-sim-store-'));
  temporaryDirectories.push(directory);
  return join(directory, 'nested', 'state.json');
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('sim state store — PHI-free by construction', () => {
  it('refuses a record without the synthetic watermark', () => {
    const store = new InMemorySimStateStore();
    expect(() => store.writeEffect({ ...record, synthetic: false as unknown as true })).toThrow(
      /without the synthetic watermark is refused/,
    );
  });

  it('refuses prose in any ref-shaped field — a value cannot be smuggled into the ledger', () => {
    const store = new InMemorySimStateStore();
    expect(() =>
      store.writeEffect({ ...record, effectKey: 'Payment for Jordan Kim, DOB 1980-02-02' }),
    ).toThrow(/is not ref-grammar/);
    expect(() => store.writeEffect({ ...record, idempotencyKey: 'MRN 55512345' })).toThrow(
      /is not ref-grammar/,
    );
  });

  it('refuses anything but a sha-256 digest in payloadHash (the bytes never enter the store)', () => {
    const store = new InMemorySimStateStore();
    expect(() => store.writeEffect({ ...record, payloadHash: 'card 4242424242424242' })).toThrow(
      /payloadHash must be a sha-256 hex digest/,
    );
  });

  it('refuses a malformed instant, state, or attempt count', () => {
    const store = new InMemorySimStateStore();
    expect(() => store.writeEffect({ ...record, lastSeenAt: 'yesterday' })).toThrow(
      SimStateStoreError,
    );
    expect(() => store.writeEffect({ ...record, state: 'settled' as unknown as 'landed' })).toThrow(
      /unknown effect state/,
    );
    expect(() => store.writeEffect({ ...record, attempts: 0 })).toThrow(/positive integer/);
  });

  it('refuses an unwatermarked receipt', () => {
    const store = new InMemorySimStateStore();
    expect(() =>
      store.appendReceipts([{ ...receipt, synthetic: false as unknown as true }]),
    ).toThrow(/receipt without the synthetic watermark/);
  });
});

describe('sim state store — ledger behaviour', () => {
  it('keys effects by rail and idempotency key, and drains receipts per rail in order', () => {
    const store = new InMemorySimStateStore();
    store.writeEffect(record);
    store.writeEffect({ ...record, railId: 'RAIL-003', idempotencyKey: 'synthetic-idem-0002' });
    expect(store.listEffects()).toHaveLength(2);
    expect(store.readEffect('RAIL-008', 'synthetic-idem-0001')?.state).toBe('landed');
    expect(store.readEffect('RAIL-008', 'synthetic-idem-9999')).toBeUndefined();

    store.appendReceipts([receipt, { ...receipt, sequence: 2, kind: 'duplicate' }]);
    store.appendReceipts([{ ...receipt, railId: 'RAIL-003' }]);
    const drained = store.drainReceipts('RAIL-008');
    expect(drained.map((entry) => entry.kind)).toEqual(['primary', 'duplicate']);
    expect(store.drainReceipts('RAIL-008')).toHaveLength(0);
    expect(store.listReceipts()).toHaveLength(1);
  });

  it('reset clears the ledger — the rollback expectation', () => {
    const store = new InMemorySimStateStore();
    store.writeEffect(record);
    store.appendReceipts([receipt]);
    store.recordHeartbeat('RAIL-008', '2026-01-01T00:00:00Z');
    store.reset();
    expect(store.snapshot()).toEqual({
      effects: [],
      receipts: [],
      heartbeats: [],
      synthetic: true,
    });
  });

  it('hashes payloads canonically — key order never changes the digest', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });
});

describe('file-backed store — the durability half of the process-kill contract', () => {
  it('survives a process death: a fresh instance reads exactly what was committed', () => {
    const path = temporaryStatePath();
    const first = new FileSimStateStore(path);
    first.writeEffect({ ...record, state: 'unknown', receiptRef: null });
    first.appendReceipts([receipt]);

    // A new instance is what a restarted process gets.
    const restarted = new FileSimStateStore(path);
    expect(restarted.readEffect('RAIL-008', 'synthetic-idem-0001')?.state).toBe('unknown');
    expect(restarted.listReceipts()).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ synthetic: true });
  });

  it('refuses to load a persisted record that lost its watermark (tamper evidence)', () => {
    const path = temporaryStatePath();
    const first = new FileSimStateStore(path);
    first.writeEffect(record);
    const tampered = JSON.parse(readFileSync(path, 'utf8')) as {
      effects: { synthetic: boolean }[];
    };
    const effect = tampered.effects[0];
    if (effect) {
      effect.synthetic = false;
    }
    writeFileSync(path, JSON.stringify(tampered), 'utf8');
    expect(() => new FileSimStateStore(path)).toThrow(/without the synthetic watermark/);
  });
});
