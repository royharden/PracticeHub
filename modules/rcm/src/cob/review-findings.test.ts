import { describe, expect, it } from 'vitest';

import { CobEngine } from './engine.js';
import { AT, coverage, episode, msp, remit, TENANT } from './fixtures.test-support.js';
import { deriveCobOrder } from './order.js';

const OTHER = 'tenant-synth-02';
const medicare = coverage('mcr', 'medicare');
const employer = coverage('emp', 'employer-ghp');
const gap = coverage('gap', 'medigap');

function inOther<T extends { tenantId: string }>(value: T): T {
  return { ...value, tenantId: OTHER };
}

describe('WP-093 attempt 2: tenant scoping (review required)', () => {
  it('the same episodeId opens independently in two tenants', () => {
    const engine = new CobEngine();
    engine.open(episode([medicare, gap]), null, AT);
    const other = engine.open(
      { ...episode([inOther(medicare), inOther(gap)]), tenantId: OTHER },
      null,
      AT,
    );
    expect(other.input.tenantId).toBe(OTHER);
    expect(engine.episode(TENANT, 'ep-1').input.tenantId).toBe(TENANT);
    expect(engine.episode(OTHER, 'ep-1').input.tenantId).toBe(OTHER);
  });

  it('the same remitId posts in both tenants; neither is a false duplicate', () => {
    const engine = new CobEngine();
    engine.open(episode([medicare, gap]), null, AT);
    engine.open({ ...episode([inOther(medicare), inOther(gap)]), tenantId: OTHER }, null, AT);
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT });
    engine.submit(OTHER, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT });
    const mine = remit('same', 'payer-mcr', 'c-1', 16_000, 4_000);
    expect(engine.postRemit(mine)).toEqual({ status: 'posted', state: 'ready' });
    expect(engine.postRemit({ ...mine, tenantId: OTHER })).toEqual({
      status: 'posted',
      state: 'ready',
    });
    expect(engine.episode(OTHER, 'ep-1').priorPayers).toHaveLength(1);
  });

  it('another tenant reads an episode exactly like an unknown id, and sees none of its events', () => {
    const engine = new CobEngine();
    engine.open(episode([medicare, gap]), null, AT);
    expect(() => engine.episode(OTHER, 'ep-1')).toThrow(/no COB episode/);
    expect(() =>
      engine.submit(OTHER, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-9', at: AT }),
    ).toThrow(/no COB episode/);
    expect(() => engine.preSubmissionCheck(OTHER, 'ep-1', 'payer-mcr')).toThrow(/no COB episode/);
    expect(() => engine.checkCrossover(OTHER, 'ep-1', '2026-03-01')).toThrow(/no COB episode/);
    expect(() =>
      engine.postRemit({ ...remit('x', 'payer-mcr', 'c-1', 16_000, 4_000), tenantId: OTHER }),
    ).toThrow(/no COB episode/);
    expect(engine.events(OTHER)).toEqual([]);
    expect(engine.events(TENANT).map((e) => e.kind)).toEqual(['opened']);
  });
});

describe('WP-093 attempt 2: accident-related liability coverage (review high)', () => {
  const wc = coverage('wc', 'workers-comp');

  it('without Medicare, the workers-comp payer pays first for an accident-related episode', () => {
    const order = deriveCobOrder(episode([employer, wc], { accidentRelated: true }), null);
    expect(order.payers.map((p) => p.payerId)).toEqual(['payer-wc', 'payer-emp']);
    expect(order.blocking).toEqual([]);
    const engine = new CobEngine();
    engine.open(episode([employer, wc], { accidentRelated: true }), null, AT);
    expect(engine.preSubmissionCheck(TENANT, 'ep-1', 'payer-emp').map((f) => f.flag)).toContain(
      'mis-ordered',
    );
    expect(engine.preSubmissionCheck(TENANT, 'ep-1', 'payer-wc')).toEqual([]);
  });

  it('with Medicare and an MSP reason that does not name the liability kind, every claim is blocked', () => {
    const order = deriveCobOrder(episode([medicare, wc], { accidentRelated: true }), msp('none'));
    expect(order.payers.map((p) => p.payerId)).toEqual(['payer-wc', 'payer-mcr']);
    expect(order.blocking.map((f) => f.flag)).toEqual(['msp-liability-conflict']);
    const engine = new CobEngine();
    engine.open(episode([medicare, wc], { accidentRelated: true }), msp('none'), AT);
    expect(engine.preSubmissionCheck(TENANT, 'ep-1', 'payer-mcr').map((f) => f.flag)).toContain(
      'msp-liability-conflict',
    );
  });

  it('with Medicare and no determination, the missing MSP blocks', () => {
    const order = deriveCobOrder(episode([medicare, wc], { accidentRelated: true }), null);
    expect(order.blocking.map((f) => f.flag)).toContain('msp-determination-missing');
  });

  it('with Medicare and the matching MSP reason, the liability payer leads with no finding', () => {
    const order = deriveCobOrder(
      episode([medicare, wc], { accidentRelated: true }),
      msp('workers-comp'),
    );
    expect(order.payers.map((p) => p.payerId)).toEqual(['payer-wc', 'payer-mcr']);
    expect(order.blocking).toEqual([]);
  });

  it('for an episode that is not accident-related, liability coverage is still excluded', () => {
    const order = deriveCobOrder(episode([employer, wc], { accidentRelated: false }), null);
    expect(order.payers.map((p) => p.payerId)).toEqual(['payer-emp']);
  });
});

describe('WP-093 attempt 2: two coverages with one payer (review medium)', () => {
  it('blocks at order time instead of stranding the secondary', () => {
    const a = coverage('a', 'medicare', { payerId: 'payer-x' });
    const b = coverage('b', 'medigap', { payerId: 'payer-x' });
    const order = deriveCobOrder(episode([a, b]), null);
    expect(order.blocking.map((f) => f.flag)).toEqual(['duplicate-payer']);
    const engine = new CobEngine();
    engine.open(episode([a, b]), null, AT);
    expect(engine.preSubmissionCheck(TENANT, 'ep-1', 'payer-x').map((f) => f.flag)).toEqual([
      'duplicate-payer',
    ]);
  });
});

describe('WP-093 attempt 2: individual commercial plans (review note)', () => {
  it('an individual plan is never a GHP, so it follows Medicare even under working-aged', () => {
    const individual = coverage('ind', 'individual-commercial');
    expect(
      deriveCobOrder(episode([individual, medicare]), msp('working-aged', 50)).payers.map(
        (p) => p.payerId,
      ),
    ).toEqual(['payer-mcr', 'payer-ind']);
    expect(
      deriveCobOrder(
        episode([coverage('grp', 'commercial'), medicare]),
        msp('working-aged', 50),
      ).payers.map((p) => p.payerId),
    ).toEqual(['payer-grp', 'payer-mcr']);
  });
});
