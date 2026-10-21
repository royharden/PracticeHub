/**
 * Named placeholders for the packages WP-092 depends on that are not yet accepted. Each type
 * stands for the named package's sealed outcome record; a later pass replaces the placeholder
 * with the landed type and reruns these tests. Synthetic data only.
 */

/** Stands for WP-088 (denials/appeals queues): one claim's mature denial outcome. */
export const WP088_PACKAGE_ID = 'WP-088' as const;
export interface Wp088DenialOutcome {
  readonly packageId: typeof WP088_PACKAGE_ID;
  readonly claimId: string;
  readonly tenantId: string;
  readonly payerId: string;
  readonly seal: string;
  readonly submittedAt: string;
  /** null while the payer has not adjudicated: pending is never a success. */
  readonly denied: boolean | null;
  readonly subgroups: Readonly<Record<string, string>>;
}

/** Stands for WP-089 (835/EFT/PLB posting): one remit's three-way reconciliation outcome. */
export const WP089_PACKAGE_ID = 'WP-089' as const;
export interface Wp089PostingOutcome {
  readonly packageId: typeof WP089_PACKAGE_ID;
  readonly remitId: string;
  readonly tenantId: string;
  readonly payerId: string;
  readonly seal: string;
  readonly receivedAt: string;
  /** 835 <-> EFT <-> ledger all agree to the penny; null while any leg is outstanding. */
  readonly reconciled: boolean | null;
  readonly subgroups: Readonly<Record<string, string>>;
}

/** Stands for WP-091 (enrollment registry): one payer x transaction liveness/enrollment check. */
export const WP091_PACKAGE_ID = 'WP-091' as const;
export interface Wp091EnrollmentCheck {
  readonly packageId: typeof WP091_PACKAGE_ID;
  readonly checkId: string;
  readonly tenantId: string;
  readonly payerId: string;
  readonly seal: string;
  readonly checkedAt: string;
  /** Enrolled with live-proof evidence on a route whose secondary shares no upstream. */
  readonly enrolledAndDiverse: boolean;
  readonly subgroups: Readonly<Record<string, string>>;
}

/**
 * Shadow claim concordance: a sealed prediction compared to the incumbent's actual result.
 * Built on the landed WP-085 sealed-mirror posture; not a placeholder.
 */
export interface ShadowConcordance {
  readonly claimId: string;
  readonly tenantId: string;
  readonly payerId: string;
  readonly seal: string;
  readonly sealedAt: string;
  /** null while the incumbent's actual outcome is not yet known. */
  readonly matchedActual: boolean | null;
  readonly subgroups: Readonly<Record<string, string>>;
}
