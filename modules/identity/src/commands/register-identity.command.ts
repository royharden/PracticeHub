/**
 * Registering an identity inquiry is an authority-bearing write: it moves
 * under `identity.person-model`, floored at `simulated`. WP-013 seeds the
 * capability at `scaffolded` (the package ceiling), so the seeded local grant
 * DENIES live registration — the activation walk to `simulated` belongs to
 * the package that takes M02 into the reference loops. Riverbend (disabled)
 * is the standing opposite-state proof.
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import {
  registerIdentityInquiry,
  type IdentityInquiry,
  type IdentityInquiryOptions,
  type IdentityInquiryOutcome,
  type MatchablePerson,
} from '../matching.js';

export interface RegisterIdentityCommandInput {
  readonly inquiry: IdentityInquiry;
  readonly existing: readonly MatchablePerson[];
  readonly options?: IdentityInquiryOptions;
}

export const registerIdentityCommand = defineCommandHandler<
  RegisterIdentityCommandInput,
  IdentityInquiryOutcome
>({
  capabilityId: 'identity.person-model',
  minimumState: 'simulated',
  handle: (_context, input) =>
    registerIdentityInquiry(input.inquiry, input.existing, input.options ?? {}),
});
