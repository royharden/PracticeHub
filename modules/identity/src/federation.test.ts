/**
 * Federation mapping unit suite (WP-014). The live dex flow is
 * dex.federation.test.ts (test:federation); this suite proves the pure
 * mapping semantics: discovery fail-closed, issuer/audience pinning, and the
 * never-auto-provision rule.
 */
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import { AuthnInvariantError } from './authn.js';
import type { SourceIdentifier } from './crosswalk.js';
import {
  assertDiscoveryDocument,
  decodeJwtPayload,
  devFederationConfig,
  devFederationSourceSystem,
  mapFederatedIdentity,
} from './federation.js';

const tenant = 'northwind-synthetic' as TenantId;
const morgan = 'np-morgan-lee' as PersonId;

const link: SourceIdentifier = {
  tenantId: tenant,
  sourceSystem: devFederationSourceSystem,
  sourceValue: 'synthetic-dex-subject-0001',
  personId: morgan,
  verification: 'verified',
  evidenceRef: 'synthetic-federation-evidence-0001',
  provenanceSource: 'synthetic-dex-federation',
  synthetic: true,
};

const discovery = {
  issuer: devFederationConfig.issuer,
  authorization_endpoint: `${devFederationConfig.issuer}/auth`,
  token_endpoint: `${devFederationConfig.issuer}/token`,
  jwks_uri: `${devFederationConfig.issuer}/keys`,
  response_types_supported: ['code'],
};

describe('OIDC discovery fail-closed', () => {
  it('accepts a well-formed document with the exact issuer', () => {
    expect(assertDiscoveryDocument(discovery, devFederationConfig.issuer).issuer).toBe(
      devFederationConfig.issuer,
    );
  });

  it('refuses a wrong issuer or a malformed document', () => {
    expect(() =>
      assertDiscoveryDocument(
        { ...discovery, issuer: 'http://evil.invalid/dex' },
        devFederationConfig.issuer,
      ),
    ).toThrow(/issuer mismatch/);
    expect(() =>
      assertDiscoveryDocument({ issuer: discovery.issuer }, devFederationConfig.issuer),
    ).toThrow(/malformed/);
  });
});

describe('federated identity mapping — never auto-provision', () => {
  const assertion = {
    issuer: devFederationConfig.issuer,
    subject: 'synthetic-dex-subject-0001',
    audience: devFederationConfig.clientId,
  };

  it('maps a known (issuer, subject) through the crosswalk', () => {
    expect(
      mapFederatedIdentity(
        [link],
        tenant,
        assertion,
        devFederationConfig.issuer,
        devFederationConfig.clientId,
      ),
    ).toEqual({
      outcome: 'mapped',
      personId: morgan,
    });
  });

  it('an unknown subject resolves to review — no person is created', () => {
    expect(
      mapFederatedIdentity(
        [link],
        tenant,
        { ...assertion, subject: 'unknown-subject' },
        devFederationConfig.issuer,
        devFederationConfig.clientId,
      ),
    ).toEqual({ outcome: 'unmapped-federated-identity', reviewRequired: true });
  });

  it('a cross-tenant link never maps — tenant is part of the crosswalk key', () => {
    expect(
      mapFederatedIdentity(
        [link],
        'riverbend-synthetic' as TenantId,
        assertion,
        devFederationConfig.issuer,
        devFederationConfig.clientId,
      ),
    ).toEqual({ outcome: 'unmapped-federated-identity', reviewRequired: true });
  });

  it('issuer and audience are pinned — anything else throws', () => {
    expect(() =>
      mapFederatedIdentity(
        [link],
        tenant,
        { ...assertion, issuer: 'http://evil.invalid' },
        devFederationConfig.issuer,
        devFederationConfig.clientId,
      ),
    ).toThrow(AuthnInvariantError);
    expect(() =>
      mapFederatedIdentity(
        [link],
        tenant,
        { ...assertion, audience: 'another-client' },
        devFederationConfig.issuer,
        devFederationConfig.clientId,
      ),
    ).toThrow(AuthnInvariantError);
  });
});

describe('JWT payload decoding (introspection helper)', () => {
  it('decodes a base64url payload segment', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', iss: discovery.issuer })).toString(
      'base64url',
    );
    expect(decodeJwtPayload(`header.${payload}.signature`)).toEqual({
      sub: 'abc',
      iss: discovery.issuer,
    });
  });

  it('refuses a token without three segments', () => {
    expect(() => decodeJwtPayload('not-a-jwt')).toThrow(AuthnInvariantError);
  });
});
