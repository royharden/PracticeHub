/**
 * The issue-session command is capability-gated (standing invariant:
 * capability-state checks + AuthorityDecision on every authority-bearing
 * write). WP-014's own seed keeps `identity.authn` at `scaffolded` (the
 * package ceiling) — the seeded grant must DENY, the synthetic `simulated`
 * grant must allow, and Riverbend (disabled) stays denied.
 */
import {
  CapabilityDeniedError,
  capabilityRegistryV1,
  foldCapabilityEvents,
  syntheticCapabilitySeedV1,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import type { AuthCredential, AuthDevice, StaffSessionRequest } from './authn.js';
import {
  issueSessionCommand,
  type IssueSessionCommandInput,
} from './commands/issue-session.command.js';

const registry = capabilityRegistryV1;
const seededGrants: readonly CapabilityGrant[] = [
  ...syntheticCapabilitySeedV1.initialGrants,
  ...foldCapabilityEvents(registry, [], syntheticCapabilitySeedV1.events),
];

const tenant = 'northwind-synthetic' as TenantId;
const morgan = 'np-morgan-lee' as PersonId;

const credentials: readonly AuthCredential[] = [
  {
    credentialId: 'ncr-morgan-password',
    tenantId: tenant,
    personId: morgan,
    audience: 'staff',
    kind: 'password',
    status: 'active',
    secretRef: 'synthetic-vault:staff-pw-0001',
    enrolledBy: 'synthetic-it-admin-001',
    evidenceRef: 'synthetic-enrollment-evidence-0001',
    synthetic: true,
  },
  {
    credentialId: 'ncr-morgan-totp',
    tenantId: tenant,
    personId: morgan,
    audience: 'staff',
    kind: 'totp',
    status: 'active',
    secretRef: 'synthetic-vault:staff-totp-0001',
    enrolledBy: 'synthetic-it-admin-001',
    evidenceRef: 'synthetic-enrollment-evidence-0002',
    synthetic: true,
  },
];
const device: AuthDevice = {
  deviceId: 'nde-morgan-workstation',
  tenantId: tenant,
  personId: morgan,
  label: 'synthetic workstation',
  status: 'active',
  firstSeenAt: '2026-03-01T08:00:00Z',
  synthetic: true,
};
const request: StaffSessionRequest = {
  sessionId: 'nsn-cmd-0001',
  tenantId: tenant,
  personId: morgan,
  staffAccountId: 'nsa-morgan-lee',
  staffAccountStatus: 'active',
  device,
  presentedCredentials: credentials,
  atIso: '2026-03-05T08:00:00Z',
  synthetic: true,
};
const input: IssueSessionCommandInput = { principal: 'staff', request };

describe('issue-session command capability gate', () => {
  it('the WP-014 seed (scaffolded) DENIES live session issuance — the ceiling is honored', () => {
    expect(() =>
      issueSessionCommand.invoke(registry, seededGrants, { tenantId: tenant, scope: {} }, input),
    ).toThrow(CapabilityDeniedError);
  });

  it('a simulated grant allows issuance and returns the AuthorityDecision', () => {
    const simulatedGrant: CapabilityGrant = {
      capabilityId: 'identity.authn',
      tenantId: 'northwind-synthetic',
      scope: {},
      state: 'simulated',
      sinceEventId: 'synthetic-cap-evt-test-0002',
      evidenceRefs: ['synthetic-gate:authn-sim-conformance'],
      rollbackRef: 'registry-event-replay',
      synthetic: true,
    };
    const invocation = issueSessionCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      input,
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.decision.capabilityId).toBe('identity.authn');
    expect(invocation.result.assurance).toBe('aal2');
  });

  it('Riverbend (disabled) is denied — the standing opposite-state proof', () => {
    expect(() =>
      issueSessionCommand.invoke(
        registry,
        seededGrants,
        { tenantId: 'riverbend-synthetic' as TenantId, scope: {} },
        input,
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
