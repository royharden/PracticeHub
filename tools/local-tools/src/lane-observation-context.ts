import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import type { PinnedFile } from './compose-config.ts';

export interface LaneObservationOptions {
  readonly workers?: 1 | 2 | 3 | 4;
  /** Local phase failure bounds, defaults1000ms; may only be reduced. */
  readonly readinessFailureMs?: number;
  readonly observationFailureMs?: number;
  readonly shutdownFailureMs?: number;
  /** Only supply an actual existing outer absolute performance.now() deadline. */
  readonly outerDeadline?: number;
}
interface ResolvedOptions {
  readonly workers: number;
  readonly readinessFailureMs: number;
  readonly observationFailureMs: number;
  readonly shutdownFailureMs: number;
  readonly outerDeadline?: number;
}
export interface ObservationJob {
  readonly index: number;
  readonly pin: PinnedFile;
}
export interface ObservationRequest {
  readonly epoch: number;
  readonly jobs: readonly ObservationJob[];
}
export interface ObservationResult {
  readonly index: number;
  readonly error: Error | null;
  readonly code?: string;
}
export interface ObservationReply {
  readonly epoch: number;
  readonly results: readonly ObservationResult[];
}
interface Slot {
  readonly worker: Worker;
  readonly port: MessagePort;
  readonly signal: Int32Array;
  readonly exited: Promise<void>;
  readonly ready: Promise<void>;
}
interface Context {
  readonly id: symbol;
  readonly options: ResolvedOptions;
  readonly slots: Slot[];
  phase: 'starting' | 'idle' | 'observing' | 'poisoned' | 'closing' | 'UNKNOWN';
  epoch: number;
  failure: Error | undefined;
}
const storage = new AsyncLocalStorage<Context>();
let owner: Context | undefined;
const failureLimitMs = 1000; // Fails closed; never enlarges caller/test deadlines.

export class LaneObservationUnknown extends Error {
  readonly disposition = 'UNKNOWN';
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}
export function laneObservationOwnerState(): {
  readonly active: boolean;
  readonly phase?: string;
  readonly workers: number;
} {
  return owner
    ? { active: true, phase: owner.phase, workers: owner.slots.length }
    : { active: false, workers: 0 };
}
function remaining(context: Context, phase: 'readiness' | 'observation' | 'shutdown'): number {
  const bound = context.options[`${phase}FailureMs`];
  return Math.min(
    bound,
    context.options.outerDeadline === undefined
      ? Infinity
      : context.options.outerDeadline - performance.now(),
  );
}
function phaseBound(value: number | undefined): number {
  const bound = value ?? failureLimitMs;
  if (!Number.isFinite(bound) || bound <= 0 || bound > failureLimitMs)
    throw new Error('Local observer failure bound must be >0 and <=1000ms');
  return bound;
}
function poison(context: Context, cause: Error): void {
  context.failure ??= cause;
  if (context.phase !== 'closing' && context.phase !== 'UNKNOWN') context.phase = 'poisoned';
}
function requireUsable(context: Context): void {
  if (
    owner !== context ||
    context.phase !== 'idle' ||
    context.failure ||
    remaining(context, 'observation') <= 0
  ) {
    const error = new LaneObservationUnknown(
      'Lane observation context is not usable',
      context.failure,
    );
    poison(context, error);
    throw error;
  }
}
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  if (!(milliseconds > 0)) throw new Error('Existing command/readiness deadline expired');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Lane observer lifecycle wait expired')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function startSlot(context: Context): Slot {
  const channel = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  // Source route uses Node24 erasable TS; tsc rewrites this relative suffix for dist.
  const workerUrl = new URL(
    import.meta.url.endsWith('.ts')
      ? './lane-source-observer.worker.ts'
      : './lane-source-observer.worker.js',
    import.meta.url,
  );
  let worker: Worker;
  try {
    worker = new Worker(workerUrl, {
      workerData: { port: channel.port2, signal: signal.buffer },
      transferList: [channel.port2],
      // Native module imports only; do not inherit Vitest require/loader instrumentation.
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
    });
  } catch (error) {
    channel.port1.close();
    channel.port2.close();
    throw error;
  }
  // Avoid worker stdio forwarding/deadlock; validation worker is forbidden to emit.
  worker.stdout.resume();
  worker.stderr.resume();
  const exited = new Promise<void>((resolve) => {
    worker.once('exit', () => resolve());
  });
  const ready = new Promise<void>((resolve, reject) => {
    worker.once('message', (value: unknown) => {
      if (value === 'ready') resolve();
      else reject(new Error('Invalid observer readiness message'));
    });
    worker.once('error', reject);
    worker.once('exit', () => reject(new Error('Observer exited before readiness')));
  });
  void ready.catch(() => {}); // Startup may abort before aggregate readiness attaches.
  worker.on('error', (error) => poison(context, error));
  worker.on('exit', () => {
    if (context.phase !== 'closing' && context.phase !== 'UNKNOWN')
      poison(context, new Error('Observer exited unexpectedly'));
  });
  return { worker, port: channel.port1, signal, exited, ready };
}
async function cleanup(context: Context): Promise<void> {
  context.phase = 'closing';
  const deadline = performance.now() + remaining(context, 'shutdown');
  for (const slot of context.slots) {
    slot.port.close();
    // Terminate request alone is NOT cleanup. Wait for every actual exit below.
    void slot.worker.terminate().catch((error: unknown) => {
      context.failure ??= error instanceof Error ? error : new Error(String(error));
    });
  }
  const settled = Promise.all(context.slots.map((slot) => slot.exited)).then(() => {
    if (owner === context) owner = undefined;
  });
  const milliseconds = deadline - performance.now();
  if (milliseconds > 0) {
    try {
      await bounded(settled, milliseconds);
      return;
    } catch (error) {
      context.phase = 'UNKNOWN';
      // Return while the thread is live. settled clears the owner only after
      // the caller releases it and the slot exit actually happens.
      throw new LaneObservationUnknown(
        'Observer cleanup unresolved; owner retained until the caller releases the thread',
        { original: context.failure, cleanup: error },
      );
    }
  }
  context.phase = 'UNKNOWN';
  throw new LaneObservationUnknown(
    'Observer cleanup unresolved; owner retained until the caller releases the thread',
    {
      original: context.failure,
      cleanup: new Error('Existing command/readiness deadline expired'),
    },
  );
}
export async function withLaneObservationContext<T>(
  options: LaneObservationOptions,
  operation: () => Promise<T>,
): Promise<T> {
  if (owner)
    throw new LaneObservationUnknown(
      'Another observer context still owns resources',
      owner.failure,
    );
  const outerDeadline = options.outerDeadline;
  if (
    outerDeadline !== undefined &&
    (!Number.isFinite(outerDeadline) || outerDeadline <= performance.now())
  )
    throw new Error('Actual outer deadline must be positive and unexpired');
  const count = options.workers ?? 4;
  if (!Number.isInteger(count) || count < 1 || count > 4)
    throw new Error('Observer worker count must be 1..4');
  const context: Context = {
    id: Symbol('lane-observation-owner'),
    options: Object.freeze({
      workers: count,
      readinessFailureMs: phaseBound(options.readinessFailureMs),
      observationFailureMs: phaseBound(options.observationFailureMs),
      shutdownFailureMs: phaseBound(options.shutdownFailureMs),
      ...(outerDeadline === undefined ? {} : { outerDeadline }),
    }),
    slots: [],
    phase: 'starting',
    epoch: 0,
    failure: undefined,
  };
  owner = context;
  try {
    const readinessDeadline = performance.now() + remaining(context, 'readiness');
    for (let index = 0; index < count; index++) context.slots.push(startSlot(context));
    await bounded(
      Promise.all(context.slots.map((slot) => slot.ready)),
      readinessDeadline - performance.now(),
    );
    if (context.failure) throw context.failure;
    context.phase = 'idle';
    return await storage.run(context, operation);
  } catch (error) {
    poison(context, error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    await cleanup(context);
  }
}

function reply(
  value: unknown,
  epoch: number,
  expected: readonly ObservationJob[],
): ObservationReply {
  if (
    !value ||
    typeof value !== 'object' ||
    !('epoch' in value) ||
    value.epoch !== epoch ||
    !('results' in value) ||
    !Array.isArray(value.results)
  )
    throw new Error('Invalid observer reply identity');
  const seen = new Set<number>();
  for (const item of value.results as unknown[]) {
    if (
      !item ||
      typeof item !== 'object' ||
      !('index' in item) ||
      typeof item.index !== 'number' ||
      seen.has(item.index) ||
      !expected.some((job) => job.index === item.index) ||
      !('error' in item) ||
      (item.error !== null && !(item.error instanceof Error))
    )
      throw new Error('Invalid observer result');
    if ('code' in item && typeof item.code !== 'string')
      throw new Error('Invalid observer error code');
    seen.add(item.index);
  }
  if (seen.size !== expected.length) throw new Error('Missing observer results');
  return value as ObservationReply;
}
export function observeLaneSourcesSync(
  descriptors: readonly (() => PinnedFile)[],
  serialRead: (pin: PinnedFile) => Buffer,
): void {
  const context = storage.getStore();
  if (!context) {
    for (const descriptor of descriptors) serialRead(descriptor());
    return;
  }
  requireUsable(context);
  context.phase = 'observing';
  const observationDeadline = performance.now() + remaining(context, 'observation');
  const jobs: ObservationJob[] = [];
  let descriptorFailure: { index: number; error: unknown } | undefined;
  // Stop schema/path prevalidation at its first error; check earlier file bytes
  // before reporting it, preserving original index-first refusal precedence.
  for (const [index, descriptor] of descriptors.entries()) {
    try {
      jobs.push({ index, pin: descriptor() });
    } catch (error) {
      descriptorFailure = { index, error };
      break;
    }
  }
  const epoch = ++context.epoch;
  const results: ObservationResult[] = [];
  const dispatched: { slot: Slot; jobs: ObservationJob[] }[] = [];
  try {
    if (!Number.isSafeInteger(epoch)) throw new Error('Observer epoch exhausted');
    if (performance.now() >= observationDeadline)
      throw new Error('Fresh observation phase expired before dispatch');
    for (const [index, slot] of context.slots.entries()) {
      const batch = jobs.filter((_, jobIndex) => jobIndex % context.slots.length === index);
      if (!batch.length) continue;
      Atomics.store(slot.signal, 0, 0);
      slot.port.postMessage({ epoch, jobs: batch } satisfies ObservationRequest);
      dispatched.push({ slot, jobs: batch });
    }
    for (const item of dispatched) {
      while (Atomics.load(item.slot.signal, 0) !== 1) {
        const timeout = observationDeadline - performance.now();
        if (!(timeout > 0)) throw new Error('Fresh source observation wait expired');
        Atomics.wait(item.slot.signal, 0, 0, timeout);
      }
      const message = receiveMessageOnPort(item.slot.port);
      if (!message) throw new Error('Observer signaled without result');
      results.push(...reply(message.message, epoch, item.jobs).results);
    }
    if (context.failure) throw context.failure;
    // Completion is fresh observation evidence only for this admission, not cache.
    for (const result of results.sort((a, b) => a.index - b.index)) {
      if (result.error) {
        if (result.code) Object.assign(result.error, { code: result.code });
        throw result.error;
      }
    }
    if (descriptorFailure) throw descriptorFailure.error;
    // Already-signaled slots bypass the wait loop. Recheck elapsed admission
    // after all reply validation, preserving known file/descriptor errors first.
    if (performance.now() >= observationDeadline)
      throw new Error('Fresh source observation phase expired before admission');
    context.phase = 'idle';
  } catch (error) {
    poison(context, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
