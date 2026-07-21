/**
 * Authority-INCREASING PDP writes move under `identity.access-policy`,
 * floored at `simulated`. WP-015 seeds the capability at `scaffolded` (the
 * package ceiling), so the seeded local grant DENIES live role assignment,
 * authority establishment, and estate unlock — the activation walk belongs
 * to the package that takes M02 into the reference loops. Riverbend
 * (disabled) is the standing opposite-state proof. Protective directions —
 * revocations, the deceased flag SET, flag corrections — are deliberately
 * NOT capability-gated (WP-012 lesson: safety transitions are never
 * gate-blocked). The domain functions stay directly testable; these
 * commands are the authority path.
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import { unlockChartForEstate, type EstateUnlock } from '../chart-lock.js';
import { assignRole, type RoleAssignment } from '../pdp.js';
import {
  establishProxyAuthority,
  type EstablishAuthorityOutcome,
  type EstablishAuthorityRequest,
} from '../proxy-authority.js';

export const assignRoleCommand = defineCommandHandler<
  { readonly existing: readonly RoleAssignment[]; readonly next: RoleAssignment },
  { readonly ended: readonly RoleAssignment[]; readonly active: RoleAssignment }
>({
  capabilityId: 'identity.access-policy',
  minimumState: 'simulated',
  handle: (_context, input) => assignRole(input.existing, input.next),
});

export const establishAuthorityCommand = defineCommandHandler<
  EstablishAuthorityRequest,
  EstablishAuthorityOutcome
>({
  capabilityId: 'identity.access-policy',
  minimumState: 'simulated',
  handle: (_context, input) => establishProxyAuthority(input),
});

export const unlockDeceasedChartCommand = defineCommandHandler<
  Parameters<typeof unlockChartForEstate>[0],
  EstateUnlock
>({
  capabilityId: 'identity.access-policy',
  minimumState: 'simulated',
  handle: (_context, input) => unlockChartForEstate(input),
});
