/**
 * WP-099 hardening H-07 (NR-151): only a notification failure is reported as one. Any other
 * invariant error raised while locking an account propagates. The fault is injected with vi.mock
 * because the chain cannot reach a non-notification invariant error with valid input.
 */
import { describe, expect, it, vi } from 'vitest';

import type * as AtoModule from '../ato.js';
import { AuthnInvariantError } from '../authn.js';

const fault = vi.hoisted(() => ({ on: false }));

vi.mock('../ato.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AtoModule>();
  const boom = (): never => {
    throw new AuthnInvariantError(
      'lockdown store write failed (injected, not a notification failure)',
    );
  };
  return {
    ...actual,
    raiseAtoLockdown: (...args: Parameters<typeof actual.raiseAtoLockdown>) =>
      fault.on ? boom() : actual.raiseAtoLockdown(...args),
    raiseAtoLockdownCommitted: (...args: Parameters<typeof actual.raiseAtoLockdownCommitted>) =>
      fault.on ? boom() : actual.raiseAtoLockdownCommitted(...args),
  };
});

const { runPortalAtoChain } = await import('./ato-chain.js');
const { CREDENTIAL_STUFFING_DRILL } = await import('./drills.js');

describe('NR-151: a non-notification invariant error is not reported as a notification failure', () => {
  it('propagates instead of producing a fail-closed notice', () => {
    fault.on = true;
    try {
      expect(() => runPortalAtoChain(CREDENTIAL_STUFFING_DRILL.chain)).toThrow(
        /lockdown store write failed/,
      );
    } finally {
      fault.on = false;
    }
  });

  it('control: with no fault, the genuine notification failure is still a fail-closed notice', () => {
    const account = runPortalAtoChain(CREDENTIAL_STUFFING_DRILL.chain).accounts.find((item) =>
      item.personId.endsWith('-06'),
    );
    expect(account?.notification.status).toBe('fail-closed');
  });
});
