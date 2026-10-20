import { describe, expect, it } from 'vitest';

import {
  assertCobTransition,
  COB_STATES,
  COB_TRANSITIONS,
  isCobTerminal,
  type CobState,
} from './state-machine.js';

const ALLOWED: ReadonlyArray<readonly [CobState, CobState]> = [
  ['ready', 'submitted'],
  ['ready', 'exception'],
  ['submitted', 'adjudicated'],
  ['submitted', 'exception'],
  ['adjudicated', 'ready'],
  ['adjudicated', 'awaiting-crossover'],
  ['adjudicated', 'complete'],
  ['adjudicated', 'exception'],
  ['awaiting-crossover', 'adjudicated'],
  ['awaiting-crossover', 'crossover-missing'],
  ['awaiting-crossover', 'exception'],
  ['crossover-missing', 'submitted'],
  ['crossover-missing', 'adjudicated'],
  ['crossover-missing', 'exception'],
];

describe('WP-093 frozen COB state machine', () => {
  it('allows exactly the listed pairs, over all 49', () => {
    expect(COB_STATES).toHaveLength(7);
    const key = (from: CobState, to: CobState) => `${from}->${to}`;
    const allowed = new Set(ALLOWED.map(([from, to]) => key(from, to)));
    let checked = 0;
    for (const from of COB_STATES) {
      for (const to of COB_STATES) {
        checked += 1;
        if (allowed.has(key(from, to))) {
          expect(() => assertCobTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertCobTransition(from, to)).toThrow(/cannot move/);
        }
      }
    }
    expect(checked).toBe(49);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(COB_TRANSITIONS)).toBe(true);
    expect(COB_STATES.every((state) => Object.isFrozen(COB_TRANSITIONS[state]))).toBe(true);
  });

  it('a later payer can only be billed from states reached through adjudication', () => {
    const intoSubmitted = COB_STATES.filter((state) =>
      COB_TRANSITIONS[state].includes('submitted'),
    );
    expect(intoSubmitted.sort()).toEqual(['crossover-missing', 'ready']);
    // crossover-missing is reachable only from awaiting-crossover, which is reachable only from adjudicated.
    expect(COB_STATES.filter((s) => COB_TRANSITIONS[s].includes('crossover-missing'))).toEqual([
      'awaiting-crossover',
    ]);
    expect(COB_STATES.filter((s) => COB_TRANSITIONS[s].includes('awaiting-crossover'))).toEqual([
      'adjudicated',
    ]);
  });

  it('complete and exception are terminal', () => {
    expect(COB_STATES.filter(isCobTerminal).sort()).toEqual(['complete', 'exception']);
  });
});
