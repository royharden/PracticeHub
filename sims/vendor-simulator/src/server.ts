/**
 * The vendor-sim service bootstrap (WP-027) — ADR-003's ONE `vendor-sim`
 * container: every rail mock behind one scenario-control API.
 *
 * The shell does three things and nothing else: build the engine (file-backed
 * ledger when a state path is configured, so the ledger outlives the process),
 * route requests through the pure handler, and honour the process-kill hooks by
 * DYING without answering — an armed crash primitive that returned a tidy 500
 * would simulate nothing.
 */

import { createServer, type ServerResponse } from 'node:http';

import { FileSimStateStore, SimProcessKill, VendorSimEngine } from '@practicehub/vendor-sim-kit';

import { railSimsV1 } from './rails.js';
import { handleSimRequest } from './service.js';

const statePath = process.env.VENDOR_SIM_STATE_PATH;
const dataPolicy = process.env.PRACTICEHUB_DATA_POLICY ?? 'synthetic-only';

export const engine = new VendorSimEngine({
  rails: railSimsV1,
  dataPolicy,
  ...(statePath === undefined ? {} : { store: new FileSimStateStore(statePath) }),
});

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function readBody(chunks: readonly Buffer[]): unknown {
  if (chunks.length === 0) {
    return undefined;
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') {
    return undefined;
  }
  return JSON.parse(raw);
}

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const url = new URL(request.url ?? '/', 'http://vendor-simulator.local');
    let body: unknown;
    try {
      body = readBody(chunks);
    } catch {
      writeJson(response, 400, { error: 'body is not json', synthetic: true });
      return;
    }
    try {
      const result = handleSimRequest(engine, {
        method: request.method ?? 'GET',
        path: url.pathname,
        ...(body === undefined ? {} : { body }),
      });
      if (result.kill === true) {
        // The kill hook: destroy the socket and die. No response, no graceful
        // shutdown — the ledger on disk is the only thing that survives.
        request.socket.destroy();
        process.exit(137);
      }
      writeJson(response, result.status, result.body);
    } catch (error) {
      if (error instanceof SimProcessKill) {
        request.socket.destroy();
        process.exit(137);
      }
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
        synthetic: true,
      });
    }
  });
});

const port = Number.parseInt(process.env.PORT ?? '9090', 10);
await new Promise<void>((resolve) => {
  server.listen(port, '0.0.0.0', resolve);
});
