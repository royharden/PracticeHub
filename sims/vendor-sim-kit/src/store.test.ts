import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type * as Fs from 'node:fs';
import { platform, tmpdir } from 'node:os';
import type * as Os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalJson,
  hashPayload,
  FileSimStateStore,
  InMemorySimStateStore,
  SimStateStoreError,
  type SimEffectRecord,
  type SimReceipt,
} from './store.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>();
  return { ...actual, platform: vi.fn(actual.platform) };
});
const actualFs = await vi.importActual<typeof Fs>('node:fs');
const actualOs = await vi.importActual<typeof Os>('node:os');

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
  vi.restoreAllMocks();
  vi.mocked(renameSync).mockReset().mockImplementation(actualFs.renameSync);
  vi.mocked(writeFileSync).mockReset().mockImplementation(actualFs.writeFileSync);
  vi.mocked(platform).mockReset().mockImplementation(actualOs.platform);
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('file-backed store — bounded rename retry and durable restoration', () => {
  function seeded(path: string): FileSimStateStore {
    const store = new FileSimStateStore(path);
    store.writeEffect({ ...record });
    store.appendReceipts([{ ...receipt }, { ...receipt, sequence: 2, kind: 'duplicate' }]);
    store.recordHeartbeat('RAIL-008', record.firstSeenAt);
    vi.mocked(renameSync).mockClear();
    vi.mocked(writeFileSync).mockClear();
    return store;
  }

  it.each(['EPERM', 'EBUSY'])(
    'retries %s on the same prepared bytes, then commits once',
    (code) => {
      const path = temporaryStatePath();
      const store = seeded(path);
      const oldBytes = readFileSync(path, 'utf8');
      const before = store.snapshot();
      vi.mocked(platform).mockReturnValue('win32');
      const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
      const snapshot = vi.spyOn(store, 'snapshot');
      const prepared: string[] = [];
      let attempts = 0;
      vi.mocked(renameSync).mockImplementation((source, destination) => {
        expect(source).toBe(`${path}.writing`);
        expect(destination).toBe(path);
        expect(readFileSync(path, 'utf8')).toBe(oldBytes);
        prepared.push(readFileSync(source, 'utf8'));
        attempts += 1;
        if (attempts < 5) throw Object.assign(new Error('sharing violation'), { code });
        actualFs.renameSync(source, destination);
      });
      store.writeEffect({ ...record, attempts: 2, state: 'partial' });
      expect(renameSync).toHaveBeenCalledTimes(5);
      expect(writeFileSync).toHaveBeenCalledTimes(1);
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(wait.mock.calls.map((call) => call[3])).toEqual([10, 20, 40, 80]);
      expect(new Set(prepared).size).toBe(1);
      expect(readFileSync(path, 'utf8')).toBe(prepared[0]);
      const expected = { ...before, effects: [{ ...record, attempts: 2, state: 'partial' }] };
      expect(store.snapshot()).toEqual(expected);
      expect(new FileSimStateStore(path).snapshot()).toEqual(expected);
      expect(existsSync(`${path}.writing`)).toBe(false);
    },
  );

  const mutations: [string, (store: FileSimStateStore) => unknown][] = [
    ['writeEffect', (store) => store.writeEffect({ ...record, attempts: 2 })],
    ['appendReceipts', (store) => store.appendReceipts([{ ...receipt, sequence: 3 }])],
    ['drainReceipts', (store) => store.drainReceipts('RAIL-008')],
    ['recordHeartbeat', (store) => store.recordHeartbeat('RAIL-008', record.lastSeenAt)],
    ['reset', (store) => store.reset()],
  ];

  describe.each(['rename', 'write'] as const)('terminal %s failure', (stage) => {
    it.each(mutations)(
      'restores %s to the last commit in the same instance and on reopen',
      (_name, mutate) => {
        const path = temporaryStatePath();
        const store = seeded(path);
        const oldBytes = readFileSync(path, 'utf8');
        const expected: unknown = JSON.parse(oldBytes);
        vi.mocked(platform).mockReturnValue('win32');
        const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
        const errors: Error[] = [];
        const fail = (): never => {
          const error = Object.assign(new Error('injected persistence failure'), {
            code: stage === 'rename' ? 'EPERM' : 'ENOSPC',
            path: `${path}.writing`,
            dest: path,
          });
          errors.push(error);
          throw error;
        };
        if (stage === 'rename') vi.mocked(renameSync).mockImplementation(fail);
        else vi.mocked(writeFileSync).mockImplementation(fail);
        let thrown: unknown;
        try {
          mutate(store);
        } catch (error) {
          thrown = error;
        }
        expect(errors).toHaveLength(stage === 'rename' ? 5 : 1);
        expect(thrown).toBe(errors.at(-1));
        expect(renameSync).toHaveBeenCalledTimes(stage === 'rename' ? 5 : 0);
        expect(writeFileSync).toHaveBeenCalledTimes(1);
        expect(wait.mock.calls.map((call) => call[3])).toEqual(
          stage === 'rename' ? [10, 20, 40, 80] : [],
        );
        expect(readFileSync(path, 'utf8')).toBe(oldBytes);
        expect(store.snapshot()).toEqual(expected);
        expect(new FileSimStateStore(path).snapshot()).toEqual(expected);
        if (stage === 'rename') expect(existsSync(`${path}.writing`)).toBe(true);
        // A failed drain/reset must not poison subsequent successful operations.
        vi.mocked(renameSync).mockImplementation(actualFs.renameSync);
        vi.mocked(writeFileSync).mockImplementation(actualFs.writeFileSync);
        const heartbeat = store.recordHeartbeat('RAIL-008', record.lastSeenAt);
        expect(heartbeat.sequence).toBe(2);
        expect(new FileSimStateStore(path).snapshot()).toEqual(store.snapshot());
      },
    );
  });

  it.each([
    ['win32', 'EIO'],
    ['win32', 'ENOENT'],
    ['win32', undefined],
    ['linux', 'EPERM'],
    ['darwin', 'EBUSY'],
  ] as const)('does not retry on %s with code %s', (os, code) => {
    const path = temporaryStatePath();
    const store = seeded(path);
    const oldBytes = readFileSync(path, 'utf8');
    vi.mocked(platform).mockReturnValue(os);
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    const error = Object.assign(new Error('nonretryable'), code === undefined ? {} : { code });
    vi.mocked(renameSync).mockImplementation(() => {
      throw error;
    });
    expect(() => store.reset()).toThrow(error);
    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe(oldBytes);
    expect(store.snapshot()).toEqual(JSON.parse(oldBytes));
  });

  it('restores the initial empty baseline when the first write fails', () => {
    const path = temporaryStatePath();
    const store = new FileSimStateStore(path);
    const before = store.snapshot();
    const error = new Error('write failed');
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw error;
    });
    expect(() => store.writeEffect(record)).toThrow(error);
    expect(store.snapshot()).toEqual(before);
    expect(existsSync(path)).toBe(false);
    expect(renameSync).not.toHaveBeenCalled();
  });

  it('restores a loaded legacy snapshot and protects it from caller aliases', () => {
    const path = temporaryStatePath();
    seeded(path);
    const legacy = { effects: [{ ...record }], receipts: [{ ...receipt }], synthetic: true };
    actualFs.writeFileSync(path, JSON.stringify(legacy), 'utf8');
    const store = new FileSimStateStore(path);
    const expected = { ...legacy, heartbeats: [] };
    Object.assign(store.readEffect(record.railId, record.idempotencyKey) ?? {}, { attempts: 99 });
    Object.assign(store.listReceipts()[0] ?? {}, { sequence: 99 });
    const error = new Error('write failed');
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw error;
    });
    expect(() => store.reset()).toThrow(error);
    expect(store.snapshot()).toEqual(expected);
    expect(new FileSimStateStore(path).snapshot()).toEqual(expected);
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(legacy));
  });

  it('restores the last commit on serialization failure without attempting IO', () => {
    const path = temporaryStatePath();
    const store = seeded(path);
    const oldBytes = readFileSync(path, 'utf8');
    const error = new Error('serialization failed');
    vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
      throw error;
    });
    expect(() => store.reset()).toThrow(error);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
    expect(store.snapshot()).toEqual(JSON.parse(oldBytes));
    expect(readFileSync(path, 'utf8')).toBe(oldBytes);
  });

  it('keeps committed effects, receipts and heartbeats isolated from exposed record aliases', () => {
    const path = temporaryStatePath();
    const store = seeded(path);
    const oldBytes = readFileSync(path, 'utf8');
    Object.assign(store.listEffects()[0] ?? {}, { attempts: 99 });
    Object.assign(store.listReceipts()[0] ?? {}, { sequence: 99 });
    Object.assign(store.listHeartbeats()[0] ?? {}, { sequence: 99 });
    const error = new Error('write failed');
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw error;
    });
    expect(() => store.recordHeartbeat('RAIL-008', record.lastSeenAt)).toThrow(error);
    expect(store.snapshot()).toEqual(JSON.parse(oldBytes));
    expect(new FileSimStateStore(path).snapshot()).toEqual(JSON.parse(oldBytes));
  });
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
