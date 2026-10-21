import { describe, expect, it } from 'vitest';

import { CobEngine, CobSubmissionRefused } from './engine.js';
import { AT, BILLED, coverage, episode, msp, remit, TENANT } from './fixtures.test-support.js';
import type { CobFlag } from './types.js';

const medicare = coverage('mcr', 'medicare');
const gapCrossover = coverage('gap', 'medigap', { crossoverEligible: true });
const gapManual = coverage('gap', 'medigap');
const employer = coverage('emp', 'employer-ghp');

function flagsOf(fn: () => unknown): CobFlag[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof CobSubmissionRefused) return error.findings.map((f) => f.flag);
    throw error;
  }
  return [];
}

function openMedicareGap(crossover: boolean) {
  const engine = new CobEngine();
  engine.open(episode([medicare, crossover ? gapCrossover : gapManual]), null, AT);
  return engine;
}

describe('WP-093 secondary is never sent before primary adjudication', () => {
  it('refuses the secondary in every pre-adjudication state of the primary', () => {
    const engine = new CobEngine();
    engine.open(episode([employer, medicare]), msp('working-aged', 50), AT);
    // ready (nothing sent)
    expect(
      flagsOf(() =>
        engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-2', at: AT }),
      ),
    ).toEqual(['secondary-before-primary-adjudicated', 'mis-ordered']);
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-emp', controlNumber: 'c-1', at: AT });
    // submitted (primary in flight)
    expect(
      flagsOf(() =>
        engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-2', at: AT }),
      ),
    ).toEqual(['secondary-before-primary-adjudicated', 'mis-ordered']);
    expect(engine.episode(TENANT, 'ep-1').submissions).toHaveLength(1);
    // adjudicated -> secondary released, carrying the primary's COB data
    expect(engine.postRemit(remit('1', 'payer-emp', 'c-1', 15_000, 3_000))).toEqual({
      status: 'posted',
      state: 'ready',
    });
    const secondary = engine.submit(TENANT, 'ep-1', {
      payerId: 'payer-mcr',
      controlNumber: 'c-2',
      at: AT,
    });
    expect(secondary.position).toBe(1);
    expect(secondary.amountMinor).toBe(3_000);
    expect(secondary.priorPayers).toEqual([
      {
        position: 0,
        payerId: 'payer-emp',
        remitId: 'rm-1',
        paidMinor: 15_000,
        adjustments: [
          { group: 'CO', reason: '45', amountMinor: 2_000 },
          { group: 'PR', reason: '2', amountMinor: 3_000 },
        ],
      },
    ]);
  });

  it('every submitted later-payer claim carries an adjudicated prior payer for each earlier position', () => {
    const engine = new CobEngine();
    engine.open(
      episode([medicare, coverage('ret', 'retiree-ghp'), coverage('mcd', 'medicaid')]),
      msp('none'),
      AT,
    );
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT });
    engine.postRemit(remit('1', 'payer-mcr', 'c-1', 12_000, 4_000));
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-ret', controlNumber: 'c-2', at: AT });
    engine.postRemit(remit('2', 'payer-ret', 'c-2', 3_000, 1_000));
    const tertiary = engine.submit(TENANT, 'ep-1', {
      payerId: 'payer-mcd',
      controlNumber: 'c-3',
      at: AT,
    });
    for (const submission of engine.episode(TENANT, 'ep-1').submissions) {
      expect(submission.priorPayers.map((p) => p.position)).toEqual(
        Array.from({ length: submission.position }, (_, i) => i),
      );
    }
    expect(tertiary.amountMinor).toBe(1_000);
    engine.postRemit(remit('3', 'payer-mcd', 'c-3', 1_000, 0));
    expect(engine.episode(TENANT, 'ep-1').state).toBe('complete');
  });

  it('refuses a secondary remit that arrives before the primary adjudicates', () => {
    const engine = new CobEngine();
    engine.open(episode([employer, medicare]), msp('working-aged', 50), AT);
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-emp', controlNumber: 'c-1', at: AT });
    expect(engine.postRemit(remit('x', 'payer-mcr', 'c-9', 1_000, 0)).status).toBe('refused');
    expect(engine.episode(TENANT, 'ep-1').state).toBe('submitted');
  });
});

describe('WP-093 mis-ordered claim flagged before submission', () => {
  it('flags Medicare billed first when the employer plan is primary (working aged, 20+)', () => {
    const engine = new CobEngine();
    engine.open(episode([medicare, employer]), msp('working-aged', 25), AT);
    expect(engine.preSubmissionCheck(TENANT, 'ep-1', 'payer-mcr').map((f) => f.flag)).toContain(
      'mis-ordered',
    );
    expect(engine.preSubmissionCheck(TENANT, 'ep-1', 'payer-emp')).toEqual([]);
    expect(() =>
      engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT }),
    ).toThrow(CobSubmissionRefused);
    expect(engine.events(TENANT, 'ep-1').map((e) => e.kind)).toEqual([
      'opened',
      'submission-refused',
    ]);
    expect(engine.episode(TENANT, 'ep-1').submissions).toHaveLength(0);
  });

  it('blocks every claim while the MSP determination is missing or stale, then releases after resequence', () => {
    const engine = new CobEngine();
    engine.open(episode([medicare, employer]), null, AT);
    expect(
      flagsOf(() =>
        engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT }),
      ),
    ).toContain('msp-determination-missing');
    engine.resequence(
      TENANT,
      'ep-1',
      [medicare, employer],
      msp('working-aged', 10, { validThrough: '2026-01-01' }),
      AT,
    );
    expect(
      flagsOf(() =>
        engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT }),
      ),
    ).toContain('msp-determination-stale');
    engine.resequence(TENANT, 'ep-1', [medicare, employer], msp('working-aged', 10), AT);
    expect(engine.preSubmissionCheck(TENANT, 'ep-1', 'payer-mcr')).toEqual([]);
  });

  it('flags an unknown payer, a re-bill of an adjudicated payer, and a closed episode', () => {
    const engine = new CobEngine();
    engine.open(episode([medicare, gapManual]), null, AT);
    expect(engine.preSubmissionCheck(TENANT, 'ep-1', 'payer-nobody').map((f) => f.flag)).toEqual([
      'unknown-payer',
    ]);
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT });
    engine.postRemit(remit('1', 'payer-mcr', 'c-1', 16_000, 4_000));
    expect(engine.preSubmissionCheck(TENANT, 'ep-1', 'payer-mcr').map((f) => f.flag)).toEqual([
      'mis-ordered',
    ]);
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-gap', controlNumber: 'c-2', at: AT });
    engine.postRemit(remit('2', 'payer-gap', 'c-2', 4_000, 0));
    expect(engine.preSubmissionCheck(TENANT, 'ep-1', 'payer-gap').map((f) => f.flag)).toEqual([
      'episode-closed',
    ]);
  });

  it('refuses to resequence after the first claim and refuses reused control numbers', () => {
    const engine = new CobEngine();
    engine.open(episode([medicare, gapManual]), null, AT);
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT });
    expect(() => engine.resequence(TENANT, 'ep-1', [medicare], null, AT)).toThrow(
      /before the first claim/,
    );
    engine.open(episode([medicare], { episodeId: 'ep-2' }), null, AT);
    expect(() =>
      engine.submit(TENANT, 'ep-2', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT }),
    ).toThrow(/control number/);
  });
});

describe('WP-093 Medicare crossover fixtures', () => {
  it('happy crossover: Medicare forwards, Medigap answers, no manual claim is ever sent', () => {
    const engine = openMedicareGap(true);
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT });
    const posted = engine.postRemit(
      remit('1', 'payer-mcr', 'c-1', 16_000, 4_000, { forwardedToPayerId: 'payer-gap' }),
    );
    expect(posted).toEqual({ status: 'posted', state: 'awaiting-crossover' });
    expect(engine.episode(TENANT, 'ep-1').awaitingCrossoverSince).toBe('2026-02-10');
    expect(
      engine.postRemit(
        remit('2', 'payer-gap', 'gap-own-icn', 4_000, 0, { postedAt: '2026-02-20T12:00:00Z' }),
      ),
    ).toEqual({
      status: 'posted',
      state: 'complete',
    });
    expect(engine.episode(TENANT, 'ep-1').submissions).toHaveLength(1);
  });

  it('duplicate crossover: a manual claim is refused while the crossover is pending', () => {
    const engine = openMedicareGap(true);
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT });
    engine.postRemit(
      remit('1', 'payer-mcr', 'c-1', 16_000, 4_000, { forwardedToPayerId: 'payer-gap' }),
    );
    expect(
      flagsOf(() =>
        engine.submit(TENANT, 'ep-1', { payerId: 'payer-gap', controlNumber: 'c-2', at: AT }),
      ),
    ).toEqual(['crossover-pending']);
    expect(engine.checkCrossover(TENANT, 'ep-1', '2026-03-12')).toBe('awaiting-crossover'); // day 30: still inside
  });

  it('duplicate crossover: a second answer for the same payer position is never posted', () => {
    const engine = openMedicareGap(true);
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT });
    engine.postRemit(
      remit('1', 'payer-mcr', 'c-1', 16_000, 4_000, { forwardedToPayerId: 'payer-gap' }),
    );
    engine.postRemit(remit('2', 'payer-gap', 'icn-a', 4_000, 0));
    expect(engine.postRemit(remit('3', 'payer-gap', 'icn-b', 4_000, 0))).toEqual({
      status: 'duplicate',
      reason: 'payer 2 already adjudicated',
    });
    expect(engine.postRemit(remit('1', 'payer-mcr', 'c-1', 16_000, 4_000)).status).toBe(
      'duplicate',
    );
    expect(engine.episode(TENANT, 'ep-1').priorPayers).toHaveLength(2);
    expect(engine.events(TENANT, 'ep-1').filter((e) => e.kind === 'duplicate-remit')).toHaveLength(
      2,
    );
  });

  it('missing crossover: after the window a manual claim is released, and a late crossover then counts once', () => {
    const engine = openMedicareGap(true);
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT });
    engine.postRemit(
      remit('1', 'payer-mcr', 'c-1', 16_000, 4_000, { forwardedToPayerId: 'payer-gap' }),
    );
    expect(engine.checkCrossover(TENANT, 'ep-1', '2026-03-13')).toBe('crossover-missing'); // day 31
    const manual = engine.submit(TENANT, 'ep-1', {
      payerId: 'payer-gap',
      controlNumber: 'c-2',
      at: '2026-03-13T09:00:00Z',
    });
    expect(manual.priorPayers.map((p) => p.payerId)).toEqual(['payer-mcr']);
    // The late crossover answer lands first and is posted; the manual claim's answer is then a duplicate.
    expect(engine.postRemit(remit('2', 'payer-gap', 'icn-late', 4_000, 0)).status).toBe('posted');
    expect(engine.postRemit(remit('3', 'payer-gap', 'c-2', 4_000, 0)).status).toBe('duplicate');
    expect(engine.episode(TENANT, 'ep-1').state).toBe('complete');
  });

  it('missing crossover: Medicare did not forward to a crossover payer, so the manual claim is released at once', () => {
    const engine = openMedicareGap(true);
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT });
    expect(engine.postRemit(remit('1', 'payer-mcr', 'c-1', 16_000, 4_000))).toEqual({
      status: 'posted',
      state: 'ready',
    });
    expect(engine.events(TENANT, 'ep-1').map((e) => e.kind)).toContain('crossover-not-forwarded');
    expect(engine.preSubmissionCheck(TENANT, 'ep-1', 'payer-gap')).toEqual([]);
  });

  it('crossover to the wrong payer, or to a payer outside crossover, is an exception', () => {
    const wrong = openMedicareGap(true);
    wrong.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT });
    wrong.postRemit(
      remit('1', 'payer-mcr', 'c-1', 16_000, 4_000, { forwardedToPayerId: 'payer-elsewhere' }),
    );
    expect(wrong.episode(TENANT, 'ep-1').state).toBe('exception');

    const ineligible = openMedicareGap(false);
    ineligible.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT });
    ineligible.postRemit(
      remit('1', 'payer-mcr', 'c-1', 16_000, 4_000, { forwardedToPayerId: 'payer-gap' }),
    );
    expect(ineligible.episode(TENANT, 'ep-1').state).toBe('exception');
  });

  it('a crossover answer with no crossover forwarded does not stand in for our claim', () => {
    const engine = openMedicareGap(false);
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT });
    engine.postRemit(remit('1', 'payer-mcr', 'c-1', 16_000, 4_000));
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-gap', controlNumber: 'c-2', at: AT });
    expect(engine.postRemit(remit('2', 'payer-gap', 'icn-unknown', 4_000, 0)).status).toBe(
      'refused',
    );
    expect(engine.postRemit(remit('3', 'payer-gap', 'c-2', 4_000, 0)).status).toBe('posted');
  });
});

describe('WP-093 penny rules on remits', () => {
  it('refuses an unbalanced remit and a remit for another charge', () => {
    const engine = openMedicareGap(false);
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT });
    const unbalanced = { ...remit('1', 'payer-mcr', 'c-1', 16_000, 4_000), paidMinor: 16_001 };
    expect(() => engine.postRemit(unbalanced)).toThrow(/does not balance/);
    expect(
      engine.postRemit(
        remit('1', 'payer-mcr', 'c-1', 16_000, 4_000, {
          billedMinor: BILLED + 1,
          adjustments: [{ group: 'PR', reason: '2', amountMinor: 4_001 }],
        }),
      ).status,
    ).toBe('refused');
    expect(engine.episode(TENANT, 'ep-1').state).toBe('submitted');
  });

  it('a zero patient balance completes the episode without billing the secondary', () => {
    const engine = openMedicareGap(false);
    engine.submit(TENANT, 'ep-1', { payerId: 'payer-mcr', controlNumber: 'c-1', at: AT });
    expect(engine.postRemit(remit('1', 'payer-mcr', 'c-1', 18_000, 0))).toEqual({
      status: 'posted',
      state: 'complete',
    });
  });
});
