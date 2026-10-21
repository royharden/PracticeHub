/**
 * Placeholder for WP-014 (authenticated sessions) and WP-015 (PDP role checks). The worklist never
 * trusts a caller's claim that a reviewer is human: it resolves an opaque reviewer session through
 * this port, and only the directory says who the principal is, what kind it is and which roles it
 * holds. WP-014/WP-015 replace the placeholder with the real session and PDP lookup.
 */
export const WP014_PACKAGE_ID = 'WP-014' as const;

export type PrincipalKind = 'human' | 'service' | 'ai';

export type CodingRole = 'coder' | 'coding-lead';

export interface ResolvedPrincipal {
  readonly principalRef: string;
  readonly tenantId: string;
  readonly kind: PrincipalKind;
  readonly roles: readonly string[];
}

export interface ReviewerDirectoryPort {
  readonly packageId: typeof WP014_PACKAGE_ID;
  /** Resolves an authenticated session to its principal, or null when the session is unknown. */
  resolve(sessionRef: string): ResolvedPrincipal | null;
}

export interface Wp014SessionSeed extends ResolvedPrincipal {
  readonly sessionRef: string;
}

export function wp014PlaceholderReviewerDirectory(
  sessions: readonly Wp014SessionSeed[],
): ReviewerDirectoryPort {
  const bySession = new Map(
    sessions.map((seed) => [
      seed.sessionRef,
      Object.freeze({
        principalRef: seed.principalRef,
        tenantId: seed.tenantId,
        kind: seed.kind,
        roles: Object.freeze([...seed.roles]),
      }),
    ]),
  );
  return {
    packageId: WP014_PACKAGE_ID,
    resolve(sessionRef: string): ResolvedPrincipal | null {
      return bySession.get(sessionRef) ?? null;
    },
  };
}
