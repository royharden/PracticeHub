import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObservationRequest } from './lane-observation-context.ts';

// what_bug_this_catches: G1 accepted valid replies after the phase/actual outer
// deadline whenever their signal was already set, bypassing the wait-loop clock.
// These mocks create no workers/files/processes. The test runs the REAL owner and
// admission control flow with an already-queued, fully indexed worker reply.
const state = vi.hoisted(() => ({ now: 0, afterReply: 0, fileError: null as Error | null }));
vi.mock('node:perf_hooks', () => ({ performance: { now: () => state.now } }));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  class Port {
    readonly queue: { message: unknown }[] = [];
    peer: Port | undefined;
    onPost: ((request: ObservationRequest) => void) | undefined;
    postMessage(request: ObservationRequest): void {
      this.onPost?.(request);
    }
    close(): void {}
  }
  class Channel {
    readonly port1 = new Port();
    readonly port2 = new Port();
    constructor() {
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
    }
  }
  class MockWorker extends EventEmitter {
    readonly stdout = { resume(): void {} };
    readonly stderr = { resume(): void {} };
    constructor(_url: URL, options: { workerData: { port: Port; signal: SharedArrayBuffer } }) {
      super();
      const parent = options.workerData.port.peer;
      if (!parent) throw new Error('Mock owner port missing');
      const signal = new Int32Array(options.workerData.signal);
      parent.onPost = (request) => {
        parent.queue.push({
          message: {
            epoch: request.epoch,
            results: request.jobs.map((job) => ({ index: job.index, error: state.fileError })),
          },
        });
        // Parent sees an already-signaled result after time advances. Its wait
        // loop never executes; only the final elapsed gate can catch G1.
        Atomics.store(signal, 0, 1);
        state.now = state.afterReply;
      };
      queueMicrotask(() => this.emit('message', 'ready'));
    }
    terminate(): Promise<number> {
      // Model the actual-exit event separately from requesting termination.
      queueMicrotask(() => this.emit('exit', 1));
      return Promise.resolve(1);
    }
  }
  return {
    MessageChannel: Channel,
    Worker: MockWorker,
    receiveMessageOnPort: (port: Port) => port.queue.shift(),
  };
});
import {
  LaneObservationUnknown,
  laneObservationOwnerState,
  observeLaneSourcesSync,
  withLaneObservationContext,
} from './lane-observation-context.ts';

const pin = { path: 'C:\\synthetic\\approved.sql', sha256: 'a'.repeat(64) };
const mustNotUseSerialRead = (): Buffer => {
  throw new Error('Context unexpectedly fell back to serial authority');
};
async function attempt(
  options: Parameters<typeof withLaneObservationContext>[0],
  descriptors = [() => pin],
): Promise<{ error: unknown; effects: number }> {
  let effects = 0;
  try {
    await withLaneObservationContext({ workers: 1, ...options }, async () => {
      observeLaneSourcesSync(descriptors, mustNotUseSerialRead);
      effects++;
    });
    return { error: null, effects };
  } catch (error) {
    return { error, effects };
  }
}
afterEach(async () => {
  // Allow mocked actual exits to settle, without treating terminate() as exit.
  await Promise.resolve();
  await Promise.resolve();
  expect(laneObservationOwnerState().active).toBe(false);
  state.now = 0;
  state.afterReply = 0;
  state.fileError = null;
});
describe('G1 elapsed admission gate', () => {
  it('refuses already-signaled valid data consumed after the local phase limit', async () => {
    state.afterReply = 1001;
    const result = await attempt({ observationFailureMs: 1000 });
    expect(result.effects).toBe(0);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toMatch(/phase expired before admission/);
  });
  it('refuses valid data after an actual outer deadline even within the local phase limit', async () => {
    state.afterReply = 51;
    const result = await attempt({ observationFailureMs: 1000, outerDeadline: 50 });
    expect(result.effects).toBe(0);
    // Outer expiry also prevents claiming timely shutdown; original admission
    // failure remains in UNKNOWN cause while actual-exit tracking owns cleanup.
    expect(result.error).toBeInstanceOf(LaneObservationUnknown);
    const cause = (result.error as Error).cause as { original: Error };
    expect(cause.original.message).toMatch(/phase expired before admission/);
  });
  it('keeps a known earlier file failure ahead of both late phase and later descriptor failure', async () => {
    state.afterReply = 1001;
    state.fileError = new Error('first pinned source SHA256 mismatch');
    const result = await attempt({}, [
      () => pin,
      () => {
        throw new Error('later descriptor path refused');
      },
    ]);
    expect(result.effects).toBe(0);
    expect((result.error as Error).message).toBe('first pinned source SHA256 mismatch');
  });
  it('keeps a known descriptor failure ahead of late successful earlier bytes', async () => {
    state.afterReply = 1001;
    const result = await attempt({}, [
      () => pin,
      () => {
        throw new Error('later descriptor path refused');
      },
    ]);
    expect(result.effects).toBe(0);
    expect((result.error as Error).message).toBe('later descriptor path refused');
  });
  it('admits a fully indexed valid reply within the local bound as positive control', async () => {
    state.afterReply = 1;
    const result = await attempt({ observationFailureMs: 1000 });
    expect(result.error).toBeNull();
    expect(result.effects).toBe(1);
  });
});
