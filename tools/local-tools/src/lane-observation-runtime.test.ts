import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  statSync,
  utimesSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Worker as NativeWorker } from 'node:worker_threads';
import type * as WorkerThreads from 'node:worker_threads';
import type { PinnedFile } from './compose-config.js';

// what_bug_this_catches: mocked G1 tests cannot detect broken src/dist entry
// resolution, lost real-thread errors, authority reused after real byte mutation,
// or UNKNOWN ownership released before actual thread exit.
// Every constructed thread below is a REAL Node Worker. Fault mode changes only
// its test-local entry or holds the termination REQUEST; no synthetic exit event,
// clock, MessagePort reply, validator result or file read is supplied.
const state = vi.hoisted(() => ({
  mode: 'product' as 'product' | 'fatal-startup' | 'no-ready' | 'hold-shutdown',
  urls: [] as string[],
  exits: [] as Promise<void>[],
  stopped: 0,
  stop: new Map<NativeWorker, () => Promise<number>>(),
  releaseShutdown: undefined as (() => void) | undefined,
}));
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerThreads>();
  class ObservedRealWorker extends actual.Worker {
    constructor(url: string | URL, options?: ConstructorParameters<typeof NativeWorker>[1]) {
      const original = String(url);
      let entry = url;
      if (state.mode === 'fatal-startup')
        entry = new URL(
          'data:text/javascript,' +
            encodeURIComponent('throw new Error("synthetic actual worker startup failure");'),
        );
      if (state.mode === 'no-ready')
        entry = new URL(
          'data:text/javascript,' + encodeURIComponent('setInterval(() => {}, 1000);'),
        );
      if (state.mode === 'hold-shutdown')
        entry = new URL(
          'data:text/javascript,' +
            encodeURIComponent(
              `await import(${JSON.stringify(original)}); setInterval(() => {}, 1000);`,
            ),
        );
      super(entry, options);
      state.urls.push(original);
      state.stop.set(this, () => super.terminate());
      state.exits.push(
        new Promise<void>((done) =>
          this.once('exit', () => {
            state.stopped++;
            state.stop.delete(this);
            done();
          }),
        ),
      );
    }
    override terminate(): Promise<number> {
      if (state.mode === 'hold-shutdown') {
        return new Promise<number>((done, fail) => {
          state.releaseShutdown = () => {
            void super.terminate().then(done, fail);
          };
        });
      }
      return super.terminate();
    }
  }
  return { ...actual, Worker: ObservedRealWorker };
});
import {
  LaneObservationUnknown,
  laneObservationOwnerState,
  observeLaneSourcesSync,
  withLaneObservationContext,
} from './lane-observation-context.js';

const roots: string[] = [];
const tempParent = realpathSync.native(tmpdir());
function fixture(text = 'SELECT 1;\n'): { root: string; pin: PinnedFile } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ph-observer-runtime-')));
  roots.push(root);
  const path = join(root, 'approved.sql');
  writeFileSync(path, text);
  return { root, pin: { path, sha256: createHash('sha256').update(text).digest('hex') } };
}
function noSerialAuthority(): Buffer {
  throw new Error('Real observer admission silently fell back to serial read');
}
async function actualExits(): Promise<void> {
  await Promise.all(state.exits);
  // Owner release follows its own actual-exit Promise aggregation.
  await Promise.resolve();
  await Promise.resolve();
}
afterEach(async () => {
  // Always release held real threads, even after a failed assertion. Waiting for
  // their REAL exits precedes fixture deletion; terminate request is not closure.
  state.releaseShutdown?.();
  await Promise.all([...state.stop.values()].map((stop) => stop()));
  await actualExits();
  expect(laneObservationOwnerState().active).toBe(false);
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tempParent || !basename(root).startsWith('ph-observer-runtime-'))
      throw new Error('Unexpected fixture deletion target');
    rmSync(root, { recursive: true, force: true });
  }
  state.mode = 'product';
  state.urls.length = 0;
  state.exits.length = 0;
  state.stopped = 0;
  state.releaseShutdown = undefined;
});

it('loads the real source TS observer and drains actual thread exit after a fresh admission', async () => {
  const { pin } = fixture();
  let effects = 0;
  await withLaneObservationContext({ workers: 1 }, async () => {
    expect(laneObservationOwnerState()).toEqual({ active: true, phase: 'idle', workers: 1 });
    observeLaneSourcesSync([() => pin], noSerialAuthority);
    effects++;
  });
  expect(effects).toBe(1);
  expect(state.urls).toHaveLength(1);
  expect(state.urls[0]).toMatch(/lane-source-observer\.worker\.ts$/);
  expect(state.stopped).toBe(1);
  expect(laneObservationOwnerState().active).toBe(false);
});

it('loads the real compiled JS observer from the current normal build', async () => {
  const { pin } = fixture();
  const compiled = pathToFileURL(
    resolve(dirname(fileURLToPath(import.meta.url)), '../dist/lane-observation-context.js'),
  ).href;
  // Existing build is a declared pinned prerequisite; no stale/source fallback,
  // build spawn or test-specific loader is installed here.
  const api = await import(compiled);
  let effects = 0;
  await api.withLaneObservationContext({ workers: 1 }, async () => {
    api.observeLaneSourcesSync([() => pin], noSerialAuthority);
    effects++;
  });
  expect(effects).toBe(1);
  expect(state.urls).toHaveLength(1);
  expect(state.urls[0]).toMatch(/lane-source-observer\.worker\.js$/);
  expect(state.stopped).toBe(1);
  expect(api.laneObservationOwnerState().active).toBe(false);
});

it('rechecks same-size restored-mtime bytes in a second admission on the same real worker', async () => {
  const { pin } = fixture('SELECT 1;\n');
  const fixedTime = new Date('2020-01-01T00:00:00Z');
  utimesSync(pin.path, fixedTime, fixedTime);
  const before = statSync(pin.path);
  let effects = 0;
  await expect(
    withLaneObservationContext({ workers: 1 }, async () => {
      observeLaneSourcesSync([() => pin], noSerialAuthority);
      writeFileSync(pin.path, 'SELECT 2;\n');
      utimesSync(pin.path, before.atime, before.mtime);
      const restored = statSync(pin.path);
      expect(restored.size).toBe(before.size);
      expect(restored.mtimeMs).toBe(before.mtimeMs);
      observeLaneSourcesSync([() => pin], noSerialAuthority);
      effects++;
    }),
  ).rejects.toThrow(/SHA256 mismatch/);
  expect(effects).toBe(0);
  expect(state.urls).toHaveLength(1);
  expect(state.stopped).toBe(1);
  expect(laneObservationOwnerState().active).toBe(false);
});

it('refuses a real file symlink with matching bytes through the product worker', async () => {
  const { root, pin } = fixture();
  const link = join(root, 'aliased.sql');
  symlinkSync(pin.path, link, 'file');
  let effects = 0;
  await expect(
    withLaneObservationContext({ workers: 1 }, async () => {
      observeLaneSourcesSync([() => ({ ...pin, path: link })], noSerialAuthority);
      effects++;
    }),
  ).rejects.toThrow(/regular non-link/);
  expect(effects).toBe(0);
  expect(statSync(pin.path).isFile()).toBe(true);
  expect(state.stopped).toBe(1);
});

it('refuses the operation when an actual thread fails before readiness and awaits its exit', async () => {
  state.mode = 'fatal-startup';
  let entered = false;
  await expect(
    withLaneObservationContext({ workers: 1 }, async () => {
      entered = true;
    }),
  ).rejects.toThrow(/synthetic actual worker startup failure/);
  expect(entered).toBe(false);
  expect(state.stopped).toBe(1);
  expect(laneObservationOwnerState().active).toBe(false);
});

it('times out readiness closed for an actual non-ready thread and then awaits its exit', async () => {
  state.mode = 'no-ready';
  let entered = false;
  await expect(
    withLaneObservationContext({ workers: 1, readinessFailureMs: 25 }, async () => {
      entered = true;
    }),
  ).rejects.toThrow(/lifecycle wait expired/);
  expect(entered).toBe(false);
  expect(state.stopped).toBe(1);
  expect(laneObservationOwnerState().active).toBe(false);
});

it('retains UNKNOWN and rejects new ownership while the real product thread is still live', async () => {
  state.mode = 'hold-shutdown';
  const { pin } = fixture();
  const original = new Error('operation refused after actual fresh guard');
  let failure: unknown;
  try {
    await withLaneObservationContext({ workers: 1, shutdownFailureMs: 10 }, async () => {
      observeLaneSourcesSync([() => pin], noSerialAuthority);
      throw original;
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(LaneObservationUnknown);
  expect((failure as Error).cause).toMatchObject({ original });
  expect(state.stopped).toBe(0); // interval keeps actual product entry's thread live
  expect(laneObservationOwnerState()).toEqual({ active: true, phase: 'UNKNOWN', workers: 1 });
  let entered = false;
  await expect(
    withLaneObservationContext({}, async () => {
      entered = true;
    }),
  ).rejects.toThrow(/still owns resources/);
  expect(entered).toBe(false);
  expect(state.urls).toHaveLength(1);
  const release = state.releaseShutdown;
  if (!release) throw new Error('Expected retained termination request');
  state.releaseShutdown = undefined;
  release();
  await actualExits();
  expect(state.stopped).toBe(1);
  expect(laneObservationOwnerState().active).toBe(false);
});
