import { describe, expect, it } from 'vitest';

import type { RulePack } from '../edit-library.js';
import { ClearinghouseRouter, type PayerRoute } from '../router.js';
import { ClearinghouseSim, type ClaimResponse } from './ch-sim.js';
import {
  ClaimLifecycle,
  SimulatedCrash,
  type ClaimSubmission,
  type CrashPoint,
} from './lifecycle.js';
import { InMemoryClaimStore, type ClaimRecord } from './store.js';

function stored(store: InMemoryClaimStore, claimId: string): ClaimRecord {
  const record = store.get(claimId);
  if (!record) {
    throw new Error(`missing ${claimId}`);
  }
  return record;
}

const WINDOW = 60_000;

const route: PayerRoute = {
  payerId: 'payer-1',
  primary: 'ch-sim-A',
  secondary: 'ch-sim-B',
  enrolledTransactions: ['837', '835'],
};

const pack: RulePack = {
  packId: 'ncci-test',
  family: 'NCCI',
  version: '1',
  effectiveOn: '2026-01-01',
  edits: [{ editId: 'edit-1', code: '99999', maxUnits: null }],
};

function claim(n: number, overrides: Partial<ClaimSubmission> = {}): ClaimSubmission {
  return {
    claimId: `claim-${String(n)}`,
    tenantId: 'tenant-synth',
    payerId: 'payer-1',
    controlNumber: `ctl-${String(n)}`,
    totalMinor: 12_500,
    lines: [{ lineId: 'line-1', code: '99213', units: 1, serviceDate: '2026-09-01' }],
    ...overrides,
  };
}

function harness() {
  const store = new InMemoryClaimStore();
  const simA = new ClearinghouseSim('ch-sim-A');
  const simB = new ClearinghouseSim('ch-sim-B');
  const clock = { now: 1_000_000 };
  const engine = (crashPoint: CrashPoint | null = null) =>
    new ClaimLifecycle({
      store,
      router: new ClearinghouseRouter([route], 'dual-rail'),
      rails: [simA, simB],
      clock: () => clock.now,
      orphanWindowMs: WINDOW,
      rulePacks: [pack],
      faults: {
        crashAt: (point) => {
          if (point === crashPoint) {
            throw new SimulatedCrash(point);
          }
        },
      },
    });
  return { store, simA, simB, clock, engine };
}

describe('WP-086 claim lifecycle', () => {
  it('runs validation -> 837 -> 999 -> 277CA -> status', () => {
    const { simA, engine } = harness();
    const lifecycle = engine();
    expect(lifecycle.register(claim(1)).state).toBe('validated');
    expect(lifecycle.submit('claim-1').state).toBe('submitted');
    expect(simA.receipts('tenant-synth', 'ctl-1')).toBe(1);
    expect(lifecycle.ingest(simA.respond('tenant-synth', 'ctl-1', '999', 'accepted')).status).toBe(
      'applied',
    );
    lifecycle.ingest(simA.respond('tenant-synth', 'ctl-1', '277CA', 'accepted'));
    const final = lifecycle.ingest(simA.respond('tenant-synth', 'ctl-1', '277', 'finalized'));
    expect(final.claim?.state).toBe('finalized');
    expect(final.claim?.history.map((entry) => entry.to)).toEqual([
      'validated',
      'submitting',
      'submitted',
      'ack-accepted',
      'payer-accepted',
      'finalized',
    ]);
  });

  it('rejects a claim the edit library flags and never submits it', () => {
    const { simA, engine } = harness();
    const lifecycle = engine();
    const record = lifecycle.register(
      claim(2, {
        lines: [{ lineId: 'line-1', code: '99999', units: 1, serviceDate: '2026-09-01' }],
      }),
    );
    expect(record.state).toBe('invalid');
    expect(record.edits.map((edit) => edit.editId)).toEqual(['edit-1']);
    expect(() => lifecycle.submit('claim-2')).toThrow(/cannot move from invalid/);
    expect(simA.receipts('tenant-synth', 'ctl-2')).toBe(0);
  });

  it('applies only the rule-pack version in force on the service date', () => {
    const { store, simA, simB } = harness();
    const older: RulePack = {
      ...pack,
      packId: 'ncci-2025',
      version: '2025',
      effectiveOn: '2025-01-01',
    };
    const lifecycle = new ClaimLifecycle({
      store,
      router: new ClearinghouseRouter([route], 'dual-rail'),
      rails: [simA, simB],
      clock: () => 1,
      orphanWindowMs: WINDOW,
      rulePacks: [older, pack],
    });
    const record = lifecycle.register(
      claim(26, {
        lines: [{ lineId: 'line-1', code: '99999', units: 1, serviceDate: '2026-09-01' }],
      }),
    );
    expect(record.edits.map((edit) => edit.packId)).toEqual(['ncci-test']);
  });
});

describe('WP-086 kill tests (I-H)', () => {
  it('persists submitting before the call and the result after it', () => {
    const { store } = harness();
    const seen: string[] = [];
    const lifecycle = new ClaimLifecycle({
      store,
      router: new ClearinghouseRouter([route], 'dual-rail'),
      rails: [new ClearinghouseSim('ch-sim-A')],
      clock: () => 1,
      orphanWindowMs: WINDOW,
      faults: {
        crashAt: (point, claimId) => {
          seen.push(`${point}:${store.get(claimId)?.state ?? 'missing'}`);
        },
      },
    });
    lifecycle.register(claim(3));
    lifecycle.submit('claim-3');
    expect(seen).toEqual(['before-call:submitting', 'after-call:submitting']);
    expect(store.get('claim-3')?.state).toBe('submitted');
  });

  it('a crash before the call recovers to unknown and resends exactly once', () => {
    const { store, simA, simB, engine } = harness();
    engine().register(claim(4));
    expect(() => engine('before-call').submit('claim-4')).toThrow(SimulatedCrash);
    expect(store.get('claim-4')?.state).toBe('submitting');
    expect(simA.receipts('tenant-synth', 'ctl-4')).toBe(0);

    const restarted = engine();
    const report = restarted.recover();
    expect(report).toEqual({
      recoveredToUnknown: ['claim-4'],
      reconciled: [],
      resent: ['claim-4'],
      exceptions: [],
    });
    expect(store.get('claim-4')?.state).toBe('submitted');
    expect(store.get('claim-4')?.history.map((entry) => entry.to)).toContain('unknown');
    expect(restarted.recover().resent).toEqual([]);
    expect(simA.receipts('tenant-synth', 'ctl-4')).toBe(1);
    expect(simB.receipts('tenant-synth', 'ctl-4')).toBe(0);
  });

  it('a crash after the call recovers by status and never resends', () => {
    const { store, simA, engine } = harness();
    engine().register(claim(5));
    expect(() => engine('after-call').submit('claim-5')).toThrow(SimulatedCrash);
    expect(store.get('claim-5')?.state).toBe('submitting');
    expect(simA.receipts('tenant-synth', 'ctl-5')).toBe(1);

    const report = engine().recover();
    expect(report.reconciled).toEqual(['claim-5']);
    expect(report.resent).toEqual([]);
    expect(store.get('claim-5')?.state).toBe('submitted');
    expect(simA.receipts('tenant-synth', 'ctl-5')).toBe(1);
  });

  it('never marks a crashed claim accepted, even when the rail holds a 999', () => {
    const { store, simA, engine } = harness();
    engine().register(claim(6));
    expect(() => engine('after-call').submit('claim-6')).toThrow(SimulatedCrash);
    simA.respond('tenant-synth', 'ctl-6', '999', 'accepted');
    const restarted = engine();
    restarted.recover();
    const history = store.get('claim-6')?.history.map((entry) => entry.to) ?? [];
    expect(history.indexOf('unknown')).toBeLessThan(history.indexOf('ack-accepted'));
    expect(store.get('claim-6')?.state).toBe('ack-accepted');
    expect(simA.receipts('tenant-synth', 'ctl-6')).toBe(1);
  });

  it('a crash during the recovery resend still yields one submission', () => {
    const { store, simA, engine } = harness();
    engine().register(claim(7));
    expect(() => engine('before-call').submit('claim-7')).toThrow(SimulatedCrash);
    expect(() => engine('after-call').recover()).toThrow(SimulatedCrash);
    expect(store.get('claim-7')?.state).toBe('submitting');
    const report = engine().recover();
    expect(report.reconciled).toEqual(['claim-7']);
    expect(report.resent).toEqual([]);
    expect(simA.receipts('tenant-synth', 'ctl-7')).toBe(1);
  });

  it('a dropped connection after receipt is reconciled, not resent', () => {
    const { store, simA, engine } = harness();
    const lifecycle = engine();
    lifecycle.register(claim(8));
    simA.dropConnectionAfterNextReceipt();
    expect(lifecycle.submit('claim-8').state).toBe('unknown');
    expect(lifecycle.recover().reconciled).toEqual(['claim-8']);
    expect(store.get('claim-8')?.state).toBe('submitted');
    expect(simA.receipts('tenant-synth', 'ctl-8')).toBe(1);
  });

  it('a claim both rails hold goes to an owned exception', () => {
    const { store, simB, engine } = harness();
    engine().register(claim(9));
    expect(() => engine('after-call').submit('claim-9')).toThrow(SimulatedCrash);
    simB.submit837({
      tenantId: 'tenant-synth',
      claimId: 'claim-9',
      controlNumber: 'ctl-9',
      totalMinor: 12_500,
    });
    expect(engine().recover().exceptions).toEqual(['claim-9']);
    expect(store.get('claim-9')?.exception).toEqual({
      reason: 'accepted-on-multiple-rails',
      owner: 'rcm-lead',
    });
  });
});

describe('WP-086 orphan queue', () => {
  it('surfaces a claim only after the window with no 999 or 277CA', () => {
    const { clock, engine } = harness();
    const lifecycle = engine();
    lifecycle.register(claim(10));
    lifecycle.submit('claim-10');
    clock.now += WINDOW - 1;
    expect(lifecycle.orphans()).toEqual([]);
    clock.now += 1;
    expect(lifecycle.orphans().map((record) => record.claimId)).toEqual(['claim-10']);
  });

  it('resubmits a claim no rail received exactly once', () => {
    const { store, simA, clock, engine } = harness();
    const lifecycle = engine();
    lifecycle.register(claim(11));
    simA.loseNextSubmissionSilently();
    expect(lifecycle.submit('claim-11').state).toBe('submitted');
    expect(simA.receipts('tenant-synth', 'ctl-11')).toBe(0);

    clock.now += WINDOW;
    expect(lifecycle.recoverOrphans()).toEqual({
      answered: [],
      resubmitted: ['claim-11'],
      exceptions: [],
    });
    expect(lifecycle.recoverOrphans().resubmitted).toEqual([]);
    expect(simA.receipts('tenant-synth', 'ctl-11')).toBe(1);

    clock.now += WINDOW;
    expect(lifecycle.recoverOrphans()).toEqual({
      answered: [],
      resubmitted: [],
      exceptions: ['claim-11'],
    });
    expect(store.get('claim-11')?.exception).toEqual({ reason: 'ack-missing', owner: 'rcm-lead' });
    expect(store.get('claim-11')?.resubmissions).toBe(1);
    expect(simA.receipts('tenant-synth', 'ctl-11')).toBe(1);
  });

  it('escalates instead of resubmitting a second time', () => {
    const { store, simA, clock, engine } = harness();
    const lifecycle = engine();
    lifecycle.register(claim(12));
    simA.loseNextSubmissionSilently();
    lifecycle.submit('claim-12');
    clock.now += WINDOW;
    simA.loseNextSubmissionSilently();
    expect(lifecycle.recoverOrphans().resubmitted).toEqual(['claim-12']);
    clock.now += WINDOW;
    expect(lifecycle.recoverOrphans().exceptions).toEqual(['claim-12']);
    expect(store.get('claim-12')?.exception?.reason).toBe('orphan-resubmit-exhausted');
    expect(store.get('claim-12')?.resubmissions).toBe(1);
  });

  it('applies a response the rail holds before considering a resubmit', () => {
    const { simA, clock, engine } = harness();
    const lifecycle = engine();
    lifecycle.register(claim(13));
    lifecycle.submit('claim-13');
    simA.respond('tenant-synth', 'ctl-13', '999', 'accepted');
    clock.now += WINDOW;
    expect(lifecycle.recoverOrphans().answered).toEqual(['claim-13']);
    expect(lifecycle.get('claim-13')?.state).toBe('ack-accepted');
    expect(simA.receipts('tenant-synth', 'ctl-13')).toBe(1);
  });

  it('routes a missing 277CA to the owned exception queue', () => {
    const { store, simA, clock, engine } = harness();
    const lifecycle = engine();
    lifecycle.register(claim(14));
    lifecycle.submit('claim-14');
    lifecycle.ingest(simA.respond('tenant-synth', 'ctl-14', '999', 'accepted'));
    clock.now += WINDOW;
    expect(lifecycle.recoverOrphans().exceptions).toEqual(['claim-14']);
    expect(store.get('claim-14')?.exception).toEqual({
      reason: 'payer-ack-missing',
      owner: 'rcm-lead',
    });
  });
});

describe('WP-086 control-number dedupe', () => {
  it('rejects a duplicate control number within a tenant', () => {
    const { store, engine } = harness();
    const lifecycle = engine();
    lifecycle.register(claim(15));
    expect(() => lifecycle.register(claim(16, { controlNumber: 'ctl-15' }))).toThrow(
      expect.objectContaining({ code: 'CLAIM_DUPLICATE_CONTROL' }),
    );
    const direct = { ...stored(store, 'claim-15'), claimId: 'claim-17' };
    expect(() => store.insert(direct)).toThrow(
      expect.objectContaining({ code: 'CLAIM_DUPLICATE_CONTROL' }),
    );
    expect(
      lifecycle.register(claim(18, { controlNumber: 'ctl-15', tenantId: 'tenant-other' })).state,
    ).toBe('validated');
  });

  it('treats a repeated response as a no-op and keeps unmatched responses', () => {
    const { simA, engine } = harness();
    const lifecycle = engine();
    lifecycle.register(claim(19));
    lifecycle.submit('claim-19');
    const ack = simA.respond('tenant-synth', 'ctl-19', '999', 'accepted');
    expect(lifecycle.ingest(ack).status).toBe('applied');
    expect(lifecycle.ingest(ack).status).toBe('duplicate');
    const stray = simA.respond('tenant-synth', 'ctl-none', '277CA', 'accepted');
    expect(lifecycle.ingest(stray).status).toBe('orphan');
    expect(lifecycle.orphanResponses()).toEqual([stray]);
  });
});

describe('WP-086 response ordering (rework 1)', () => {
  it('P1: a 999 rejection that arrives while the claim is submitting is kept and applied', () => {
    const { store, simA, clock, engine } = harness();
    engine().register(claim(21));
    expect(() => engine('after-call').submit('claim-21')).toThrow(SimulatedCrash);
    const restarted = engine();
    const rejection = simA.respond('tenant-synth', 'ctl-21', '999', 'rejected');
    expect(restarted.ingest(rejection).status).toBe('parked');
    expect(restarted.parkedResponses('claim-21')).toEqual([rejection]);
    restarted.recover();
    expect(store.get('claim-21')?.state).toBe('ack-rejected');
    expect(restarted.parkedResponses('claim-21')).toEqual([]);
    expect(restarted.ingest(rejection).status).toBe('duplicate');
    clock.now += WINDOW;
    expect(restarted.orphans()).toEqual([]);
    expect(restarted.recoverOrphans().exceptions).toEqual([]);
  });

  it('P2: a 277 finalized that arrives before its 277CA finalizes the claim once the 277CA lands', () => {
    const { simA, engine } = harness();
    const lifecycle = engine();
    lifecycle.register(claim(22));
    lifecycle.submit('claim-22');
    lifecycle.ingest(simA.respond('tenant-synth', 'ctl-22', '999', 'accepted'));
    const early = simA.respond('tenant-synth', 'ctl-22', '277', 'finalized');
    expect(lifecycle.ingest(early).status).toBe('parked');
    expect(lifecycle.ingest(early).status).toBe('parked');
    const payerAck = lifecycle.ingest(simA.respond('tenant-synth', 'ctl-22', '277CA', 'accepted'));
    expect(payerAck.claim?.state).toBe('finalized');
    expect(lifecycle.parkedResponses('claim-22')).toEqual([]);
    expect(lifecycle.ingest(early).status).toBe('duplicate');
  });

  it('F2: a 999 rejection after a 277CA acceptance raises an owned exception', () => {
    const { store, simA, engine } = harness();
    const lifecycle = engine();
    lifecycle.register(claim(23));
    lifecycle.submit('claim-23');
    lifecycle.ingest(simA.respond('tenant-synth', 'ctl-23', '277CA', 'accepted'));
    const late = simA.respond('tenant-synth', 'ctl-23', '999', 'rejected');
    expect(lifecycle.ingest(late)).toMatchObject({
      status: 'conflict',
      claim: { state: 'exception' },
    });
    expect(store.get('claim-23')?.exception).toEqual({
      reason: 'contradictory-999',
      owner: 'rcm-lead',
    });
    expect(lifecycle.conflicts()).toEqual([
      { response: late, claimId: 'claim-23', stateAtArrival: 'payer-accepted', owner: 'rcm-lead' },
    ]);
  });

  it('logs a contradiction against a terminal claim without dropping it', () => {
    const { store, simA, engine } = harness();
    const lifecycle = engine();
    lifecycle.register(claim(24));
    lifecycle.submit('claim-24');
    lifecycle.ingest(simA.respond('tenant-synth', 'ctl-24', '999', 'rejected'));
    const contradicting = simA.respond('tenant-synth', 'ctl-24', '277CA', 'accepted');
    expect(lifecycle.ingest(contradicting).status).toBe('conflict');
    expect(store.get('claim-24')?.state).toBe('ack-rejected');
    expect(lifecycle.conflicts().map((item) => item.stateAtArrival)).toEqual(['ack-rejected']);
  });

  it('treats a late response that agrees with the claim as superseded', () => {
    const { simA, engine } = harness();
    const lifecycle = engine();
    lifecycle.register(claim(25));
    lifecycle.submit('claim-25');
    lifecycle.ingest(simA.respond('tenant-synth', 'ctl-25', '277CA', 'accepted'));
    const lateAck = simA.respond('tenant-synth', 'ctl-25', '999', 'accepted');
    expect(lifecycle.ingest(lateAck).status).toBe('superseded');
    expect(lifecycle.conflicts()).toEqual([]);
  });
});

describe('WP-086 targeted fix: responses to a claim in exception are kept (pass-2 review)', () => {
  it('a late 277CA rejected after payer-ack-missing is recorded and parked, not consumed', () => {
    const { store, simA, clock, engine } = harness();
    const lifecycle = engine();
    lifecycle.register(claim(27));
    lifecycle.submit('claim-27');
    lifecycle.ingest(simA.respond('tenant-synth', 'ctl-27', '999', 'accepted'));
    clock.now += WINDOW;
    expect(lifecycle.recoverOrphans().exceptions).toEqual(['claim-27']);
    expect(store.get('claim-27')?.exception?.reason).toBe('payer-ack-missing');
    const late = simA.respond('tenant-synth', 'ctl-27', '277CA', 'rejected');
    expect(lifecycle.ingest(late).status).toBe('parked');
    expect(lifecycle.conflicts()).toEqual([
      { response: late, claimId: 'claim-27', stateAtArrival: 'exception', owner: 'rcm-lead' },
    ]);
    expect(lifecycle.parkedResponses('claim-27')).toEqual([late]);
    expect(lifecycle.ingest(late).status).toBe('parked');
    expect(lifecycle.conflicts()).toHaveLength(1);
  });

  it('a late 999 after an accepted-on-multiple-rails exception is recorded and parked', () => {
    const { simA, simB, engine } = harness();
    engine().register(claim(28));
    expect(() => engine('after-call').submit('claim-28')).toThrow(SimulatedCrash);
    simB.submit837({
      tenantId: 'tenant-synth',
      claimId: 'claim-28',
      controlNumber: 'ctl-28',
      totalMinor: 12_500,
    });
    const lifecycle = engine();
    expect(lifecycle.recover().exceptions).toEqual(['claim-28']);
    const late = simA.respond('tenant-synth', 'ctl-28', '999', 'accepted');
    expect(lifecycle.ingest(late).status).toBe('parked');
    expect(lifecycle.conflicts().map((item) => [item.claimId, item.stateAtArrival])).toEqual([
      ['claim-28', 'exception'],
    ]);
    expect(lifecycle.parkedResponses('claim-28')).toEqual([late]);
  });
});

describe('WP-086 hardening H-24 (NR-178)', () => {
  it('resolving an exception closes its parked responses with the resolver as owner', () => {
    const { store, simA, clock, engine } = harness();
    const lifecycle = engine();
    lifecycle.register(claim(29));
    lifecycle.submit('claim-29');
    lifecycle.ingest(simA.respond('tenant-synth', 'ctl-29', '999', 'accepted'));
    clock.now += WINDOW;
    lifecycle.recoverOrphans();
    const late = simA.respond('tenant-synth', 'ctl-29', '277CA', 'rejected');
    lifecycle.ingest(late);
    const result = lifecycle.resolveException('claim-29', {
      by: 'rcm-lead-1',
      reason: 'payer rejection confirmed by phone',
    });
    expect(result.closed).toEqual([late]);
    expect(lifecycle.parkedResponses('claim-29')).toEqual([]);
    expect(store.get('claim-29')?.exception).toEqual({
      reason: 'payer-ack-missing',
      owner: 'rcm-lead',
      resolution: {
        by: 'rcm-lead-1',
        at: clock.now,
        reason: 'payer rejection confirmed by phone',
        closedResponseIds: [late.responseId],
      },
    });
    expect(store.get('claim-29')?.history.at(-1)?.reason).toBe(
      'exception-resolved: payer rejection confirmed by phone',
    );
    expect(lifecycle.ingest(late).status).toBe('duplicate');
    expect(() =>
      lifecycle.resolveException('claim-1', { by: 'rcm-lead-1', reason: 'x' }),
    ).toThrow();
    expect(() => lifecycle.resolveException('claim-29', { by: 'rcm-lead-1', reason: ' ' })).toThrow(
      expect.objectContaining({ code: 'CLAIM_INVALID' }),
    );
  });

  it('caps parked responses re-tried per drain; the rest drain on the next advance', () => {
    const { store, simA, simB, clock } = harness();
    const make = (crashPoint: CrashPoint | null) =>
      new ClaimLifecycle({
        store,
        router: new ClearinghouseRouter([route], 'dual-rail'),
        rails: [simA, simB],
        clock: () => clock.now,
        orphanWindowMs: WINDOW,
        maxParkedDrainPerCall: 1,
        faults: {
          crashAt: (point) => {
            if (point === crashPoint) throw new SimulatedCrash(point);
          },
        },
      });
    make(null).register(claim(30));
    expect(() => make('after-call').submit('claim-30')).toThrow(SimulatedCrash);
    const lifecycle = make(null);
    const response = (responseId: string, kind: '999' | '277CA'): ClaimResponse => ({
      responseId,
      railId: 'ch-sim-A',
      kind,
      tenantId: 'tenant-synth',
      controlNumber: 'ctl-30',
      outcome: 'accepted',
    });
    expect(lifecycle.ingest(response('mail-999', '999')).status).toBe('parked');
    expect(lifecycle.ingest(response('mail-277ca', '277CA')).status).toBe('parked');
    lifecycle.recover();
    expect(store.get('claim-30')?.state).toBe('ack-accepted');
    expect(lifecycle.parkedResponses('claim-30').map((item) => item.responseId)).toEqual([
      'mail-277ca',
    ]);
    clock.now += WINDOW;
    lifecycle.recoverOrphans();
    expect(store.get('claim-30')?.state).toBe('payer-accepted');
    expect(lifecycle.parkedResponses('claim-30')).toEqual([]);
  });
});

describe('WP-086 hardening H-27 (NR-182)', () => {
  it('drainAllParked applies an over-cap parked response without waiting for another advance', () => {
    const { store, simA, simB, clock } = harness();
    const make = (crashPoint: CrashPoint | null) =>
      new ClaimLifecycle({
        store,
        router: new ClearinghouseRouter([route], 'dual-rail'),
        rails: [simA, simB],
        clock: () => clock.now,
        orphanWindowMs: WINDOW,
        maxParkedDrainPerCall: 1,
        faults: {
          crashAt: (point) => {
            if (point === crashPoint) throw new SimulatedCrash(point);
          },
        },
      });
    make(null).register(claim(31));
    expect(() => make('after-call').submit('claim-31')).toThrow(SimulatedCrash);
    const lifecycle = make(null);
    const response = (
      responseId: string,
      kind: '999' | '277CA' | '277',
      outcome: ClaimResponse['outcome'],
    ): ClaimResponse => ({
      responseId,
      railId: 'ch-sim-A',
      kind,
      tenantId: 'tenant-synth',
      controlNumber: 'ctl-31',
      outcome,
    });
    lifecycle.ingest(response('sweep-999', '999', 'accepted'));
    lifecycle.ingest(response('sweep-277ca', '277CA', 'accepted'));
    lifecycle.ingest(response('sweep-277', '277', 'finalized'));
    lifecycle.recover();
    // The cap left two responses stranded; no further advance is coming.
    expect(store.get('claim-31')?.state).toBe('ack-accepted');
    expect(lifecycle.parkedResponses('claim-31')).toHaveLength(2);
    expect(lifecycle.drainAllParked()).toEqual([{ claimId: 'claim-31', applied: 1, remaining: 1 }]);
    expect(lifecycle.drainAllParked()).toEqual([{ claimId: 'claim-31', applied: 1, remaining: 0 }]);
    expect(store.get('claim-31')?.state).toBe('finalized');
    expect(lifecycle.drainAllParked()).toEqual([]);
  });
});

describe('WP-086 claim store', () => {
  it('rejects a stale write to the claim store', () => {
    const { store, engine } = harness();
    engine().register(claim(20));
    const record = stored(store, 'claim-20');
    expect(() => store.put({ ...record, state: 'submitting' })).toThrow(
      expect.objectContaining({ code: 'CLAIM_VERSION' }),
    );
  });
});
