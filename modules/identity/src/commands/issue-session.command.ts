/**
 * Issuing a session is an authority-bearing write: it moves under
 * `identity.authn`, floored at `simulated`. WP-014 seeds the capability at
 * `scaffolded` (the package ceiling), so the seeded local grant DENIES live
 * session issuance — the activation walk to `simulated` belongs to the
 * package that takes authn into the reference loops. Riverbend (disabled) is
 * the standing opposite-state proof. Session/device REVOCATION and lockdown
 * release stay outside the gate by design: protective directions are never
 * gate-blocked (session-api.md; WP-012 lesson).
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import {
  issuePortalSession,
  issueStaffSession,
  type AuthSession,
  type PortalSessionRequest,
  type StaffSessionRequest,
} from '../authn.js';

export type IssueSessionCommandInput =
  | { readonly principal: 'staff'; readonly request: StaffSessionRequest }
  | { readonly principal: 'portal'; readonly request: PortalSessionRequest };

export const issueSessionCommand = defineCommandHandler<IssueSessionCommandInput, AuthSession>({
  capabilityId: 'identity.authn',
  minimumState: 'simulated',
  handle: (_context, input) =>
    input.principal === 'staff'
      ? issueStaffSession(input.request)
      : issuePortalSession(input.request),
});
