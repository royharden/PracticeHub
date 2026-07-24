/**
 * Vendor-registry governance command (WP-026, M07). Registering a vendor,
 * EXECUTING or RENEWING its BAA, and EXPANDING its permitted PHI categories are
 * PERMISSION-INCREASING writes — they widen what the runtime egress guard will
 * let leave the platform boundary. So they move under `platform.vendor-registry`,
 * floored at `simulated`. WP-026 seeds the capability at `scaffolded` (the
 * package ceiling), so the seeded local grant DENIES a live registration; the
 * activation walk belongs to the package that takes M07 into the reference
 * loops. Riverbend (disabled) is the standing opposite-state proof.
 *
 * REQ-PLAT-001 exception 4 (a category expansion requires compliance sign-off
 * before the guard honors it) is enforced two ways: the capability gate governs
 * WHO may write, and `validateVendorEvent` refuses a permission-increasing event
 * that names no `approvedBy`. Protective directions (suspend, baa-lapsed,
 * reinstate) and the egress guard's own evaluate/block are NEVER gated — a lapse
 * must always be recordable and a block must always fire (the audit.emit
 * precedent).
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import { validateVendorEvent, type VendorRegistryEvent } from '../vendor-registry.js';

export interface RegisterVendorBaaCommandInput {
  readonly event: VendorRegistryEvent;
}

export const registerVendorBaaCommand = defineCommandHandler<
  RegisterVendorBaaCommandInput,
  VendorRegistryEvent
>({
  capabilityId: 'platform.vendor-registry',
  minimumState: 'simulated',
  handle: (_context, input) => {
    validateVendorEvent(input.event);
    return input.event;
  },
});
