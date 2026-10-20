import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  created: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));

// This tests real environment preflight, stopping at a mocked connection boundary.
// It never establishes database identity, grants, RLS, or SQL execution evidence.
vi.mock('pg', () => ({
  Client: class {
    constructor(config: unknown) {
      boundary.created(config);
    }

    connect() {
      return boundary.connect();
    }

    query() {
      return boundary.query();
    }

    end() {
      return boundary.end();
    }
  },
}));

import { connectProof } from './db-test-harness.js';

const connectionBoundary = new Error('unit-only connection boundary; no database connected');
const preflightMessage = 'Labs DB proof requires explicit synthetic grant and complete target pins';

beforeEach(() => {
  vi.clearAllMocks();
  boundary.connect.mockRejectedValue(connectionBoundary);
  boundary.end.mockResolvedValue(undefined);
  vi.stubEnv('PRACTICEHUB_LABS_DB_GRANT', 'synthetic-rollback-only-with-role-effects');
  vi.stubEnv('PRACTICEHUB_LABS_DB_HOST', '127.0.0.1');
  vi.stubEnv('PRACTICEHUB_LABS_DB_PORT', '55432');
  vi.stubEnv('PRACTICEHUB_LABS_DB_NAME', 'ph_labs_proof_unit');
  vi.stubEnv('PRACTICEHUB_LABS_DB_OID', '10001');
  vi.stubEnv('PRACTICEHUB_LABS_DB_SYSTEM_ID', '10000000000000001');
  vi.stubEnv('PRACTICEHUB_LABS_DB_USER', 'synthetic-proof-owner');
  vi.stubEnv('PRACTICEHUB_LABS_DB_PASSWORD', 'synthetic-unit-only');
  vi.stubEnv('PRACTICEHUB_LABS_DB_LEGACY_PORT_PIN', '55432');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function rejectsBeforeClient(): Promise<void> {
  await expect(connectProof()).rejects.toThrow(preflightMessage);
  expect(boundary.created).not.toHaveBeenCalled();
  expect(boundary.connect).not.toHaveBeenCalled();
  expect(boundary.query).not.toHaveBeenCalled();
}

async function reachesConnectionBoundary(port: number): Promise<void> {
  const outcome: unknown = await connectProof().catch((error: unknown) => error);
  if (outcome instanceof Error && outcome.message === preflightMessage) {
    // On the preserved original preflight, verify rejection precedes every
    // Client action before failing the intended legacy-compatibility assertion.
    expect(boundary.created).not.toHaveBeenCalled();
    expect(boundary.connect).not.toHaveBeenCalled();
    expect(boundary.query).not.toHaveBeenCalled();
  }
  expect(outcome).toBe(connectionBoundary);
  expect(boundary.created).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      host: '127.0.0.1',
      port,
      database: 'ph_labs_proof_unit',
      user: 'synthetic-proof-owner',
    }),
  );
  expect(boundary.connect).toHaveBeenCalledOnce();
  expect(boundary.end).toHaveBeenCalledOnce();
  expect(boundary.query).not.toHaveBeenCalled();
}

describe('labs proof-target preflight: adopted legacy port exception', () => {
  it('reaches only the connection boundary for complete 55432 target with exact legacy pin', async () => {
    // Regression: the original band-only preflight rejects this complete target
    // before constructing any Client. Only the exact adopted-port pin repairs it.
    await reachesConnectionBoundary(55432);
  });

  it.each([undefined, '', '55433', '055432', '55432 '])(
    'rejects legacy target before Client for absent or inexact pin %s',
    async (pin) => {
      vi.stubEnv('PRACTICEHUB_LABS_DB_LEGACY_PORT_PIN', pin);
      await rejectsBeforeClient();
    },
  );

  it.each(['5432', '55433', '19999', '30000', '65535'])(
    'rejects other outside-band port %s despite the exact 55432 pin',
    async (port) => {
      vi.stubEnv('PRACTICEHUB_LABS_DB_PORT', port);
      await rejectsBeforeClient();
    },
  );

  it.each(['20000', '29999'])(
    'retains the existing band boundary %s without a legacy pin',
    async (port) => {
      vi.stubEnv('PRACTICEHUB_LABS_DB_PORT', port);
      vi.stubEnv('PRACTICEHUB_LABS_DB_LEGACY_PORT_PIN', undefined);
      await reachesConnectionBoundary(Number(port));
    },
  );

  it.each([undefined, '', '20000.5', 'not-a-port'])(
    'rejects absent or invalid selected port %s',
    async (port) => {
      vi.stubEnv('PRACTICEHUB_LABS_DB_PORT', port);
      await rejectsBeforeClient();
    },
  );

  it.each([
    ['HOST', 'localhost'],
    ['HOST', '192.0.2.1'],
    ['HOST', ''],
    ['GRANT', ''],
    ['GRANT', 'ungranted'],
    ['NAME', 'practicehub'],
    ['NAME', ''],
    ['OID', ''],
    ['OID', '0'],
    ['SYSTEM_ID', ''],
    ['SYSTEM_ID', 'not-an-id'],
    ['USER', ''],
    ['PASSWORD', ''],
  ])(
    'retains the %s preflight rejection for value %s even with the exact legacy pin',
    async (field, value) => {
      vi.stubEnv(`PRACTICEHUB_LABS_DB_${field}`, value);
      await rejectsBeforeClient();
    },
  );
});
