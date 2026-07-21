/**
 * Consent governance commands (WP-018). PERMISSION-INCREASING consent writes
 * (grant / renew / unblock) are authority-bearing and move under
 * `consent.operational`, floored at `simulated`. WP-018 seeds the capability at
 * `scaffolded` (the package ceiling), so the seeded local grant DENIES live
 * grant recording — the activation walk belongs to the package that takes M03
 * into the reference loops. Riverbend (disabled) is the standing opposite-state
 * proof.
 *
 * PROTECTIVE writes — revoke / expire / block, including STOP-driven opt-outs —
 * are NEVER routed here and never capability-gated: an opt-out and a fail-closed
 * deny must always land (the audit-store `audit.emit` precedent). Callers append
 * those through `appendConsentEvent` directly.
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import {
  appendConsentEvent,
  ConsentError,
  type ConsentAction,
  type ConsentEvent,
  type ConsentEventInput,
} from '../consent.js';

/** Actions this gated command accepts — the permission-increasing set. */
export const permissionIncreasingActions: readonly ConsentAction[] = ['grant', 'renew', 'unblock'];

export interface RecordConsentGrantCommandInput {
  readonly log: readonly ConsentEvent[];
  readonly event: ConsentEventInput;
}

export const recordConsentGrantCommand = defineCommandHandler<
  RecordConsentGrantCommandInput,
  { readonly event: ConsentEvent; readonly log: readonly ConsentEvent[] }
>({
  capabilityId: 'consent.operational',
  minimumState: 'simulated',
  handle: (_context, input) => {
    if (!permissionIncreasingActions.includes(input.event.action)) {
      throw new ConsentError(
        `recordConsentGrant handles only ${permissionIncreasingActions.join('/')}; ` +
          `${JSON.stringify(input.event.action)} is a protective write — append it ungated`,
      );
    }
    return appendConsentEvent(input.log, input.event);
  },
});
