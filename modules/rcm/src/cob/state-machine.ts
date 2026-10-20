import { RcmShadowError } from '../contracts.js';

/**
 * WP-093 COB state machine (frozen). One episode walks its payer order one position at a time:
 *
 *   ready --submit--> submitted --remit--> adjudicated
 *   adjudicated --> ready (next payer needs a claim from us)
 *               --> awaiting-crossover (Medicare forwarded it to the next payer)
 *               --> complete (no balance or no next payer)
 *   awaiting-crossover --remit from next payer--> adjudicated
 *                      --window elapsed--> crossover-missing --manual claim--> submitted
 *
 * A later payer's claim can only leave `ready` or `crossover-missing`, and both are reachable only
 * through `adjudicated`, so no secondary claim exists before the primary is adjudicated.
 */
export type CobState =
  | 'ready'
  | 'submitted'
  | 'adjudicated'
  | 'awaiting-crossover'
  | 'crossover-missing'
  | 'complete'
  | 'exception';

export const COB_TRANSITIONS: Readonly<Record<CobState, readonly CobState[]>> = Object.freeze({
  ready: Object.freeze(['submitted', 'exception'] as const),
  submitted: Object.freeze(['adjudicated', 'exception'] as const),
  adjudicated: Object.freeze(['ready', 'awaiting-crossover', 'complete', 'exception'] as const),
  'awaiting-crossover': Object.freeze(['adjudicated', 'crossover-missing', 'exception'] as const),
  'crossover-missing': Object.freeze(['submitted', 'adjudicated', 'exception'] as const),
  complete: Object.freeze([] as const),
  exception: Object.freeze([] as const),
});

export const COB_STATES = Object.freeze(Object.keys(COB_TRANSITIONS) as CobState[]);

export function isCobTerminal(state: CobState): boolean {
  return COB_TRANSITIONS[state].length === 0;
}

export function assertCobTransition(from: CobState, to: CobState): void {
  if (!COB_TRANSITIONS[from].includes(to)) {
    throw new RcmShadowError('COB_TRANSITION', `COB episode cannot move from ${from} to ${to}`);
  }
}
