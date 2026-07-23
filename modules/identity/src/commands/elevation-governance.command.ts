/**
 * The one authority-INCREASING elevation write moves under
 * `identity.break-glass`, floored at `simulated`. WP-017 seeds the capability
 * at `scaffolded` (the package ceiling), so the seeded local grant DENIES a
 * live break-glass grant — the activation walk belongs to the package that
 * takes M02 into the reference loops. Riverbend (disabled) is the standing
 * opposite-state proof. Everything else in this package is protective/detective
 * — offboarding revocation, anomaly investigation, recertification attestation
 * — and is deliberately NOT capability-gated (WP-012 lesson: safety directions
 * are never gate-blocked). The domain functions stay directly testable; this
 * command is the authority path (a denied invocation's decision still maps to a
 * break-glass audit record via the grant's own audit input).
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import {
  grantBreakGlass,
  type BreakGlassGrantOutcome,
  type BreakGlassGrantRequest,
} from '../break-glass.js';

export const grantBreakGlassCommand = defineCommandHandler<
  BreakGlassGrantRequest,
  BreakGlassGrantOutcome
>({
  capabilityId: 'identity.break-glass',
  minimumState: 'simulated',
  handle: (_context, input) => grantBreakGlass(input),
});
