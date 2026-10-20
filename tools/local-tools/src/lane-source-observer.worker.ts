import { parentPort, workerData } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { readPinnedFile } from './compose-config.ts';
import type { ObservationRequest, ObservationResult } from './lane-observation-context.ts';

// One verifier truth: workers call the same readPinnedFile implementation.
const data = workerData as { port: MessagePort; signal: SharedArrayBuffer };
const signal = new Int32Array(data.signal);
data.port.on('message', (request: ObservationRequest) => {
  const results: ObservationResult[] = request.jobs.map((job) => {
    try {
      readPinnedFile(job.pin);
      return { index: job.index, error: null };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
      return { index: job.index, error, ...(code === undefined ? {} : { code }) };
    }
  });
  data.port.postMessage({ epoch: request.epoch, results });
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
if (!parentPort) throw new Error('Observation worker requires owner');
parentPort.postMessage('ready');
