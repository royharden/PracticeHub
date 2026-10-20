import { RcmShadowError } from '../contracts.js';

/**
 * WP-086 claim state machine (frozen). Every submission passes through
 * `submitting`, which is persisted before the clearinghouse call; the
 * result is persisted after it. A process that dies while a claim is
 * `submitting` recovers it to `unknown`, never to an accepted state (I-H).
 * A response that contradicts an accepted claim moves it to `exception`.
 */
export type ClaimState =
  | 'validated'
  | 'invalid'
  | 'submitting'
  | 'unknown'
  | 'submitted'
  | 'ack-accepted'
  | 'ack-rejected'
  | 'payer-accepted'
  | 'payer-rejected'
  | 'finalized'
  | 'exception';

export const CLAIM_TRANSITIONS: Readonly<Record<ClaimState, readonly ClaimState[]>> = Object.freeze(
  {
    validated: Object.freeze(['submitting'] as const),
    invalid: Object.freeze([] as const),
    submitting: Object.freeze(['submitted', 'unknown'] as const),
    unknown: Object.freeze(['submitted', 'submitting', 'exception'] as const),
    submitted: Object.freeze(['ack-accepted', 'ack-rejected', 'submitting', 'exception'] as const),
    'ack-accepted': Object.freeze(['payer-accepted', 'payer-rejected', 'exception'] as const),
    'ack-rejected': Object.freeze([] as const),
    'payer-accepted': Object.freeze(['finalized', 'exception'] as const),
    'payer-rejected': Object.freeze([] as const),
    finalized: Object.freeze([] as const),
    exception: Object.freeze([] as const),
  },
);

export function isTerminal(state: ClaimState): boolean {
  return CLAIM_TRANSITIONS[state].length === 0;
}

export function assertTransition(from: ClaimState, to: ClaimState): void {
  if (!CLAIM_TRANSITIONS[from].includes(to)) {
    throw new RcmShadowError('CLAIM_TRANSITION', `claim cannot move from ${from} to ${to}`);
  }
}
