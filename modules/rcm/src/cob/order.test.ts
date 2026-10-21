import { describe, expect, it } from 'vitest';

import { coverage, episode, msp } from './fixtures.test-support.js';
import { deriveCobOrder } from './order.js';

const medicare = coverage('mcr', 'medicare');
const employer = coverage('emp', 'employer-ghp');

function payerIds(...args: Parameters<typeof deriveCobOrder>): string[] {
  return deriveCobOrder(...args).payers.map((p) => p.payerId);
}

describe('WP-093 MSP claim order (R6-REQ-030)', () => {
  it.each([
    [
      'working aged, employer of 20+: GHP first',
      msp('working-aged', 20),
      ['payer-emp', 'payer-mcr'],
    ],
    [
      'working aged, employer under 20: Medicare first',
      msp('working-aged', 19),
      ['payer-mcr', 'payer-emp'],
    ],
    ['disability, employer of 100+: GHP first', msp('disability', 100), ['payer-emp', 'payer-mcr']],
    [
      'disability, employer under 100: Medicare first',
      msp('disability', 99),
      ['payer-mcr', 'payer-emp'],
    ],
    [
      'ESRD coordination period: GHP first',
      msp('esrd-coordination', 5),
      ['payer-emp', 'payer-mcr'],
    ],
    ['no MSP reason: Medicare first', msp('none'), ['payer-mcr', 'payer-emp']],
  ])('%s', (_label, determination, expected) => {
    expect(payerIds(episode([medicare, employer]), determination)).toEqual(expected);
  });

  it('retiree coverage follows Medicare; Medigap follows Medicare; Medicaid is last', () => {
    const coverages = [
      coverage('mcd', 'medicaid'),
      coverage('gap', 'medigap'),
      coverage('ret', 'retiree-ghp'),
      medicare,
    ];
    expect(payerIds(episode(coverages), msp('none'))).toEqual([
      'payer-mcr',
      'payer-ret',
      'payer-gap',
      'payer-mcd',
    ]);
  });

  it('a liability payer leads for an accident-related episode; a conflicting MSP reason blocks instead of dropping it', () => {
    const wc = coverage('wc', 'workers-comp');
    expect(
      payerIds(episode([medicare, wc], { accidentRelated: true }), msp('workers-comp')),
    ).toEqual(['payer-wc', 'payer-mcr']);
    expect(
      payerIds(episode([medicare, wc], { accidentRelated: false }), msp('workers-comp')),
    ).toEqual(['payer-mcr']);
    const conflicted = deriveCobOrder(
      episode([medicare, wc], { accidentRelated: true }),
      msp('none'),
    );
    expect(conflicted.payers.map((p) => p.payerId)).toEqual(['payer-wc', 'payer-mcr']);
    expect(conflicted.blocking.map((f) => f.flag)).toEqual(['msp-liability-conflict']);
  });

  it('drops coverage outside its effective dates and other patients', () => {
    const lapsed = coverage('old', 'employer-ghp', { effectiveTo: '2025-12-31' });
    const future = coverage('new', 'commercial', { effectiveFrom: '2026-06-01' });
    const other = coverage('oth', 'commercial', { patientId: 'pt-other' });
    expect(payerIds(episode([medicare, lapsed, future, other]), null)).toEqual(['payer-mcr']);
  });

  it('is deterministic when ranks tie', () => {
    const a = coverage('a', 'commercial');
    const b = coverage('b', 'commercial');
    expect(payerIds(episode([b, a]), null)).toEqual(payerIds(episode([a, b]), null));
  });
});

describe('WP-093 blocking findings', () => {
  it('Medicare plus a group plan with no MSP determination blocks', () => {
    const order = deriveCobOrder(episode([medicare, employer]), null);
    expect(order.blocking.map((f) => f.flag)).toEqual(['msp-determination-missing']);
  });

  it('Medicare with only Medigap and Medicaid needs no determination', () => {
    const order = deriveCobOrder(
      episode([medicare, coverage('gap', 'medigap'), coverage('mcd', 'medicaid')]),
      null,
    );
    expect(order.blocking).toEqual([]);
  });

  it('a determination that ended before service blocks', () => {
    const order = deriveCobOrder(
      episode([medicare, employer]),
      msp('working-aged', 50, { validThrough: '2026-01-19' }),
    );
    expect(order.blocking.map((f) => f.flag)).toEqual(['msp-determination-stale']);
  });

  it('Original Medicare and Medicare Advantage together block', () => {
    const order = deriveCobOrder(episode([medicare, coverage('ma', 'medicare-advantage')]), null);
    expect(order.blocking.map((f) => f.flag)).toContain('multiple-medicare-coverages');
  });

  it('Medigap without Medicare blocks, and no coverage blocks', () => {
    expect(
      deriveCobOrder(episode([coverage('gap', 'medigap')]), null).blocking.map((f) => f.flag),
    ).toContain('medigap-without-medicare');
    expect(deriveCobOrder(episode([]), null).blocking.map((f) => f.flag)).toEqual([
      'no-payable-coverage',
    ]);
  });

  it('refuses a determination for another patient or without an employer size', () => {
    expect(() =>
      deriveCobOrder(episode([medicare]), msp('none', null, { patientId: 'pt-other' })),
    ).toThrow(/another patient/);
    expect(() => deriveCobOrder(episode([medicare, employer]), msp('working-aged', null))).toThrow(
      /employer size/,
    );
  });
});
