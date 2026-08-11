import { describe, expect, it } from 'vitest';

import { VendorSimEngine } from './engine.js';
import { RailSimError, SimProcessKill, type RailRequest, type RailSim } from './rail.js';
import { FileSimStateStore, InMemorySimStateStore } from './store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testRail: RailSim = {
  railId: 'RAIL-000',
  authorityId: 'AUTH-000',
  name: 'kit-test-rail',
  pinnedVendorVersion: '2026-01-01',
  operations: ['send'],
  presets: [],
  heartbeat: { expectedEffectsPerWindow: 2, volumeTolerance: 0, emitsIdleHeartbeat: false },
  effectKeyFor: (operation, request) => `synthetic:rail-000/${operation}/${request.idempotencyKey}`,
};

function engine(store = new InMemorySimStateStore()): VendorSimEngine {
  return new VendorSimEngine({ rails: [testRail], store });
}

function request(overrides: Partial<RailRequest> = {}): RailRequest {
  return {
    railId: 'RAIL-000',
    operation: 'send',
    idempotencyKey: 'synthetic-idem-0001',
    payloadRef: 'synthetic-payload-0001',
    requestedAt: '2026-01-01T00:00:00Z',
    payload: { note: 'synthetic-body' },
    synthetic: true,
    ...overrides,
  };
}

function arm(
  target: VendorSimEngine,
  primitiveId: string,
  options: Record<string, unknown> = {},
): void {
  target.controller.armScenario({
    railId: 'RAIL-000',
    primitiveId,
    dataPolicy: 'synthetic-only',
    options,
  });
}

describe('dispatch — the ledger decides before any injection', () => {
  it('lands a fresh effect and issues one receipt', () => {
    const sim = engine();
    const response = sim.dispatch(request());
    expect(response.status).toBe('accepted');
    expect(response.effectState).toBe('landed');
    expect(response.attempts).toBe(1);
    expect(response.receiptRef).toBe('synthetic:rail-000/send/synthetic-idem-0001:r1');
    expect(sim.drainReceipts('RAIL-000').map((entry) => entry.kind)).toEqual(['primary']);
  });

  it('never stores the payload — only its digest', () => {
    const sim = engine();
    sim.dispatch(request({ payload: { secretish: 'synthetic-body-value' } }));
    const dump = JSON.stringify(sim.snapshot());
    expect(dump).not.toContain('synthetic-body-value');
    expect(sim.snapshot().effects[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves a re-delivered key to the SAME receipt with no second effect', () => {
    const sim = engine();
    const first = sim.dispatch(request());
    const second = sim.dispatch(request({ requestedAt: '2026-01-01T00:00:05Z' }));
    expect(second.status).toBe('deduplicated');
    expect(second.duplicateOf).toBe(first.receiptRef);
    expect(second.attempts).toBe(2);
    expect(second.resendsExternalEffect).toBe(false);
    expect(sim.snapshot().effects).toHaveLength(1);
    expect(sim.drainReceipts('RAIL-000')).toHaveLength(1);
  });

  it('resolves an UNKNOWN effect to reconciliation — a blind resend has no code path', () => {
    const sim = engine();
    arm(sim, 'X-05');
    const uncertain = sim.dispatch(request());
    expect(uncertain.status).toBe('uncertain');
    expect(uncertain.requiresReconciliation).toBe(true);

    const retry = sim.dispatch(request({ requestedAt: '2026-01-01T00:01:00Z' }));
    expect(retry.status).toBe('uncertain');
    expect(retry.requiresReconciliation).toBe(true);
    expect(retry.attempts).toBe(2);
    expect(sim.snapshot().effects).toHaveLength(1);
    expect(sim.snapshot().receipts).toHaveLength(0);
  });

  it('lets a genuinely not-landed effect be retried, and the retry can succeed', () => {
    const sim = engine();
    arm(sim, 'X-16');
    expect(sim.dispatch(request()).status).toBe('unavailable');
    const retry = sim.dispatch(request({ requestedAt: '2026-01-01T00:00:30Z' }));
    expect(retry.status).toBe('accepted');
    expect(retry.attempts).toBe(2);
    expect(sim.snapshot().effects).toHaveLength(1);
  });

  it('refuses an unknown rail, an undeclared operation, non-synthetic input, and prose refs', () => {
    const sim = engine();
    expect(() => sim.dispatch(request({ railId: 'RAIL-999' }))).toThrow(RailSimError);
    expect(() => sim.dispatch(request({ operation: 'delete-everything' }))).toThrow(
      /does not declare operation/,
    );
    expect(() => sim.dispatch(request({ synthetic: false as unknown as true }))).toThrow(
      /synthetic data only/,
    );
    expect(() => sim.dispatch(request({ payloadRef: 'Jordan Kim, 1980-02-02' }))).toThrow(
      /is not ref-grammar/,
    );
  });
});

describe('process-kill hooks — what the ledger holds at death IS the contract', () => {
  it('before-effect: nothing recorded, so a replay is a safe first sighting', () => {
    const sim = engine();
    arm(sim, 'X-02', { killPoint: 'before-effect' });
    expect(() => sim.dispatch(request())).toThrow(SimProcessKill);
    expect(sim.snapshot().effects).toHaveLength(0);

    const afterRestart = sim.dispatch(request({ requestedAt: '2026-01-01T00:02:00Z' }));
    expect(afterRestart.status).toBe('accepted');
    expect(afterRestart.attempts).toBe(1);
  });

  it('after-effect-before-receipt: the UNKNOWN record is persisted BEFORE the death', () => {
    const sim = engine();
    arm(sim, 'X-02', { killPoint: 'after-effect-before-receipt' });
    expect(() => sim.dispatch(request())).toThrow(SimProcessKill);
    const record = sim.snapshot().effects[0];
    expect(record?.state).toBe('unknown');
    expect(record?.receiptRef).toBeNull();
    expect(sim.snapshot().receipts).toHaveLength(0);

    const afterRestart = sim.dispatch(request({ requestedAt: '2026-01-01T00:02:00Z' }));
    expect(afterRestart.status).toBe('uncertain');
    expect(afterRestart.requiresReconciliation).toBe(true);
    expect(sim.snapshot().effects).toHaveLength(1);
  });

  it('after-receipt: the landed record and its receipt both survive, so a replay dedupes', () => {
    const sim = engine();
    arm(sim, 'X-02', { killPoint: 'after-receipt' });
    expect(() => sim.dispatch(request())).toThrow(SimProcessKill);
    expect(sim.snapshot().effects[0]?.state).toBe('landed');
    expect(sim.snapshot().receipts).toHaveLength(1);

    const afterRestart = sim.dispatch(request({ requestedAt: '2026-01-01T00:02:00Z' }));
    expect(afterRestart.status).toBe('deduplicated');
    expect(afterRestart.duplicateOf).toBe('synthetic:rail-000/send/synthetic-idem-0001:r1');
  });

  it('survives a REAL process boundary: a fresh store instance recovers the unknown state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vendor-sim-kill-'));
    try {
      const path = join(directory, 'state.json');
      const dying = new VendorSimEngine({ rails: [testRail], store: new FileSimStateStore(path) });
      dying.controller.armScenario({
        railId: 'RAIL-000',
        primitiveId: 'X-02',
        dataPolicy: 'synthetic-only',
        options: { killPoint: 'after-effect-before-receipt' },
      });
      expect(() => dying.dispatch(request())).toThrow(SimProcessKill);

      // A restarted process: new engine, new store instance, same file. The
      // scenario is gone (in-memory), the ledger is not.
      const restarted = new VendorSimEngine({
        rails: [testRail],
        store: new FileSimStateStore(path),
      });
      const replay = restarted.dispatch(request({ requestedAt: '2026-01-01T00:05:00Z' }));
      expect(replay.status).toBe('uncertain');
      expect(replay.attempts).toBe(2);
      expect(restarted.snapshot().effects).toHaveLength(1);
      expect(restarted.snapshot().receipts).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('scenario controller — deterministic arming', () => {
  it('holds an afterAttempts scenario back until the retry it names', () => {
    const sim = engine();
    // Attempt 1 leaves the effect not-landed, so the same key can be retried.
    arm(sim, 'X-12');
    expect(sim.dispatch(request()).status).toBe('rejected');
    expect(sim.controller.listArmed()[0]?.appliedCount).toBe(1);

    arm(sim, 'X-16', { afterAttempts: 2 });
    const retry = sim.dispatch(request({ requestedAt: '2026-01-01T00:00:10Z' }));
    expect(retry.attempts).toBe(2);
    expect(retry.status).toBe('unavailable');

    // The same scenario armed against a fresh key does NOT fire on attempt 1.
    arm(sim, 'X-16', { afterAttempts: 2 });
    const fresh = sim.dispatch(request({ idempotencyKey: 'synthetic-idem-0002' }));
    expect(fresh.attempts).toBe(1);
    expect(fresh.status).toBe('accepted');
    expect(sim.controller.listArmed()[0]?.appliedCount).toBe(0);
  });

  it('an unbounded count keeps shaping every request until it is disarmed', () => {
    const sim = engine();
    arm(sim, 'X-12', { count: 0 });
    expect(sim.dispatch(request({ idempotencyKey: 'synthetic-idem-a' })).status).toBe('rejected');
    expect(sim.dispatch(request({ idempotencyKey: 'synthetic-idem-b' })).status).toBe('rejected');
    sim.controller.disarmAll();
    expect(sim.dispatch(request({ idempotencyKey: 'synthetic-idem-c' })).status).toBe('accepted');
  });

  it('refuses to arm outside a synthetic-only environment, whatever else is true', () => {
    const sim = engine();
    expect(() =>
      sim.controller.armScenario({
        railId: 'RAIL-000',
        primitiveId: 'X-16',
        dataPolicy: 'production',
      }),
    ).toThrow(/synthetic-only environment/);
    expect(sim.controller.listArmed()).toHaveLength(0);
  });

  it('refuses an unknown primitive id and a malformed rail id', () => {
    const sim = engine();
    expect(() =>
      sim.controller.armScenario({
        railId: 'RAIL-000',
        primitiveId: 'X-99',
        dataPolicy: 'synthetic-only',
      }),
    ).toThrow(/unknown injection primitive/);
    expect(() =>
      sim.controller.armScenario({
        railId: 'the-messaging-one',
        primitiveId: 'X-01',
        dataPolicy: 'synthetic-only',
      }),
    ).toThrow(/is not a RAIL-### id/);
  });

  it('reset disarms every scenario and clears the ledger', () => {
    const sim = engine();
    arm(sim, 'X-12');
    sim.dispatch(request());
    sim.reset();
    expect(sim.controller.listArmed()).toHaveLength(0);
    expect(sim.snapshot()).toEqual({
      effects: [],
      receipts: [],
      heartbeats: [],
      synthetic: true,
    });
  });
});
