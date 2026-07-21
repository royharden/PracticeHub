/**
 * OIDC federation mapping (WP-014). Contract: docs/contracts/session-api.md
 * (FROZEN). ADR-006 Decision 1: the platform is its own IdP; dex in dev
 * simulates EXTERNAL federation (tenant SSO later). Federation asserts
 * IDENTITY only — an OIDC assertion maps `(issuer, subject)` through the
 * WP-013 source-identifier crosswalk; it never auto-provisions a person and
 * never substitutes for the platform's own assurance rules (a federated staff
 * login still issues sessions through `issueStaffSession`, MFA mandatory).
 *
 * The live dex flow is exercised by federation.e2e.test.ts against the
 * compose stack's pinned dex (`pnpm --filter @practicehub/identity run
 * test:federation`, wired into `pnpm local:test` and CI).
 */

import type { PersonId, TenantId } from '@practicehub/contracts';

import { AuthnInvariantError } from './authn.js';
import { resolvePersonBySourceId, type SourceIdentifier } from './crosswalk.js';

/** The dev federation source system in the WP-013 crosswalk. */
export const devFederationSourceSystem = 'oidc-dex';

/** The dev dex issuer/client shape (infra/dex/config.yaml, pinned in compose.yaml). */
export const devFederationConfig = {
  issuer: 'http://127.0.0.1:5556/dex',
  clientId: 'practicehub-local',
  redirectUri: 'http://127.0.0.1:53000/auth/callback',
} as const;

export interface OidcDiscoveryDocument {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly response_types_supported: readonly string[];
}

/** Fail-closed discovery validation: the issuer must match exactly. */
export function assertDiscoveryDocument(
  document: unknown,
  expectedIssuer: string,
): OidcDiscoveryDocument {
  if (
    typeof document !== 'object' ||
    document === null ||
    !('issuer' in document) ||
    !('authorization_endpoint' in document) ||
    !('token_endpoint' in document) ||
    !('jwks_uri' in document)
  ) {
    throw new AuthnInvariantError('OIDC discovery document is malformed');
  }
  const discovery = document as OidcDiscoveryDocument;
  if (discovery.issuer !== expectedIssuer) {
    throw new AuthnInvariantError(
      `OIDC issuer mismatch: expected ${expectedIssuer}, received ${discovery.issuer}`,
    );
  }
  return discovery;
}

export interface FederatedAssertion {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string;
}

/** Decode a JWT payload without verification — TEST/introspection helper only. */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const segments = token.split('.');
  if (segments.length !== 3 || segments[1] === undefined) {
    throw new AuthnInvariantError('JWT must carry three segments');
  }
  const payload = Buffer.from(segments[1], 'base64url').toString('utf8');
  return JSON.parse(payload) as Record<string, unknown>;
}

export type FederatedMapping =
  | { readonly outcome: 'mapped'; readonly personId: PersonId }
  | { readonly outcome: 'unmapped-federated-identity'; readonly reviewRequired: true };

/**
 * Map a federated assertion to a governed person through the crosswalk
 * (system = `oidc-dex` in dev, value = the assertion subject). Unknown
 * subjects are REFUSED into a review outcome — federation never
 * auto-provisions an identity (session-api.md).
 */
export function mapFederatedIdentity(
  links: readonly SourceIdentifier[],
  tenantId: TenantId,
  assertion: FederatedAssertion,
  expectedIssuer: string,
  expectedAudience: string,
): FederatedMapping {
  if (assertion.issuer !== expectedIssuer) {
    throw new AuthnInvariantError(
      `federated assertion issuer ${assertion.issuer} is not the expected ${expectedIssuer}`,
    );
  }
  if (assertion.audience !== expectedAudience) {
    throw new AuthnInvariantError(
      `federated assertion audience ${assertion.audience} is not client ${expectedAudience}`,
    );
  }
  const personId = resolvePersonBySourceId(
    links,
    tenantId,
    devFederationSourceSystem,
    assertion.subject,
  );
  if (personId === null) {
    return { outcome: 'unmapped-federated-identity', reviewRequired: true };
  }
  return { outcome: 'mapped', personId };
}
