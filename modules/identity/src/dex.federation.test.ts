/**
 * Dex federation e2e (WP-014 gate surface: "dex federation test"). Drives the
 * REAL pinned dex from compose.yaml (or the CI-started container) on
 * 127.0.0.1:5556 through a full OIDC authorization-code flow against the
 * synthetic mock connector, then proves the platform-side semantics:
 * discovery fail-closed, issuer/audience pinning, crosswalk mapping,
 * never-auto-provision, and the dark-by-registry denial (a mapped federated
 * identity still cannot mint a live session while `identity.authn` sits at
 * its scaffolded ceiling).
 */
import { createHash, randomBytes } from 'node:crypto';

import {
  CapabilityDeniedError,
  capabilityRegistryV1,
  foldCapabilityEvents,
  syntheticCapabilitySeedV1,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { beforeAll, describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import type { AuthCredential, AuthDevice } from './authn.js';
import { issueSessionCommand } from './commands/issue-session.command.js';
import type { SourceIdentifier } from './crosswalk.js';
import {
  assertDiscoveryDocument,
  decodeJwtPayload,
  devFederationConfig,
  devFederationSourceSystem,
  mapFederatedIdentity,
  type OidcDiscoveryDocument,
} from './federation.js';

const tenant = 'northwind-synthetic' as TenantId;
const morgan = 'np-morgan-lee' as PersonId;

let discovery: OidcDiscoveryDocument;
let idTokenPayload: Record<string, unknown>;

async function fetchLocation(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (location === null) {
    const body = await response.text();
    throw new Error(
      `expected a redirect from ${url}; status=${response.status} body=${body.slice(0, 300)}`,
    );
  }
  return new URL(location, url).toString();
}

beforeAll(async () => {
  const discovered: unknown = await (
    await fetch(`${devFederationConfig.issuer}/.well-known/openid-configuration`)
  ).json();
  discovery = assertDiscoveryDocument(discovered, devFederationConfig.issuer);

  // PKCE authorization-code flow against the synthetic mock connector.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorizeUrl =
    `${discovery.authorization_endpoint}?` +
    new URLSearchParams({
      client_id: devFederationConfig.clientId,
      redirect_uri: devFederationConfig.redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      state: 'synthetic-federation-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();

  // Follow dex's internal hops (connector select -> mock callback -> approval)
  // until the flow hands control back to the registered client redirect URI.
  let location = await fetchLocation(authorizeUrl);
  for (let hop = 0; hop < 8 && !location.startsWith(devFederationConfig.redirectUri); hop += 1) {
    location = await fetchLocation(location);
  }
  const callback = new URL(location);
  expect(location.startsWith(devFederationConfig.redirectUri)).toBe(true);
  expect(callback.searchParams.get('state')).toBe('synthetic-federation-state');
  const code = callback.searchParams.get('code');
  if (code === null) {
    throw new Error(`authorization flow returned no code: ${location}`);
  }

  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: devFederationConfig.redirectUri,
      client_id: devFederationConfig.clientId,
      code_verifier: verifier,
    }).toString(),
  });
  const tokens = (await tokenResponse.json()) as { id_token?: string; error?: string };
  if (!tokenResponse.ok || tokens.id_token === undefined) {
    throw new Error(`token exchange failed: ${JSON.stringify(tokens)}`);
  }
  idTokenPayload = decodeJwtPayload(tokens.id_token);
});

describe('dex federation e2e', () => {
  it('discovery serves the pinned issuer and a code flow', () => {
    expect(discovery.issuer).toBe(devFederationConfig.issuer);
    expect(discovery.response_types_supported).toContain('code');
  });

  it('the mock-connector code flow yields an id_token for our client from our issuer', () => {
    expect(idTokenPayload['iss']).toBe(devFederationConfig.issuer);
    expect(idTokenPayload['aud']).toBe(devFederationConfig.clientId);
    expect(typeof idTokenPayload['sub']).toBe('string');
    expect((idTokenPayload['sub'] as string).length).toBeGreaterThan(0);
  });

  it('the live subject maps through the crosswalk; an unknown subject never auto-provisions', () => {
    const subject = idTokenPayload['sub'] as string;
    const link: SourceIdentifier = {
      tenantId: tenant,
      sourceSystem: devFederationSourceSystem,
      sourceValue: subject,
      personId: morgan,
      verification: 'verified',
      evidenceRef: 'synthetic-federation-evidence-0001',
      provenanceSource: 'synthetic-dex-federation',
      synthetic: true,
    };
    const assertion = {
      issuer: idTokenPayload['iss'] as string,
      subject,
      audience: idTokenPayload['aud'] as string,
    };
    expect(
      mapFederatedIdentity(
        [link],
        tenant,
        assertion,
        devFederationConfig.issuer,
        devFederationConfig.clientId,
      ),
    ).toEqual({ outcome: 'mapped', personId: morgan });
    expect(
      mapFederatedIdentity(
        [],
        tenant,
        assertion,
        devFederationConfig.issuer,
        devFederationConfig.clientId,
      ),
    ).toEqual({ outcome: 'unmapped-federated-identity', reviewRequired: true });
  });

  it('a mapped federated identity still cannot mint a live session — dark by registry at scaffolded', () => {
    const seededGrants: readonly CapabilityGrant[] = [
      ...syntheticCapabilitySeedV1.initialGrants,
      ...foldCapabilityEvents(capabilityRegistryV1, [], syntheticCapabilitySeedV1.events),
    ];
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
    expect(() =>
      issueSessionCommand.invoke(
        capabilityRegistryV1,
        seededGrants,
        { tenantId: tenant, scope: {} },
        {
          principal: 'staff',
          request: {
            sessionId: 'nsn-federated-0001',
            tenantId: tenant,
            personId: morgan,
            staffAccountId: 'nsa-morgan-lee',
            staffAccountStatus: 'active',
            device,
            presentedCredentials: credentials,
            atIso: '2026-03-05T08:00:00Z',
            synthetic: true,
          },
        },
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
