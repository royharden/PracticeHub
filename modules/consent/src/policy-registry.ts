/**
 * Policy/disclosure registry (WP-019, ADR-007 Decision 3). Contract:
 * docs/contracts/clock-api.md (FROZEN §Policy/disclosure registry).
 *
 * Versioned, EFFECTIVE-DATED policy documents (ToS, privacy, NPP, disclosure
 * authorizations, AI-disclosure strings, recording notices) with per-jurisdiction
 * variants. Every consent event and every rendered disclosure records its policy
 * version (`policyVersionStamp`). The bodies live in the document store; this
 * registry holds a grammar-checked `contentRef` + `contentHash` only — free text
 * is never a column.
 *
 * Temporal model: the SHARED `@practicehub/platform-core` effective-dating
 * primitive (ADR-ADJ-002 semantics; FWD-SR-019-TEMPORAL) — this registry does
 * not re-derive version selection, it delegates to `selectEffectiveVersion`.
 */

import {
  epochEffectiveOn,
  isEffectiveDate,
  resolveEffectiveAsOf,
  selectEffectiveVersion,
} from '@practicehub/platform-core';

export const policyDocumentTypes = [
  'terms-of-service',
  'privacy-notice',
  'notice-of-privacy-practices',
  'disclosure-authorization',
  'ai-disclosure',
  'recording-notice',
] as const;
export type PolicyDocumentType = (typeof policyDocumentTypes)[number];

/** The brand's base variant (always effective; earliest version = epoch sentinel). */
export const basePolicyJurisdiction = 'floor';

export type PolicyStatus = 'draft' | 'counsel-signed';

const stateCodePattern = /^[A-Z]{2}$/;
const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const changeRefPattern = /^[a-z0-9][a-z0-9-]{0,127}$/;

export class PolicyRegistryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PolicyRegistryError';
  }
}

/**
 * One versioned, effective-dated policy document variant. Counsel-owned
 * change-controlled data (EW-025): `changeControlRef` mandatory,
 * `counsel-signed` needs `counselSignoffRef`. Append-only — a new document is a
 * new version, never a rewrite.
 */
export interface PolicyDocumentVersion {
  readonly tenantId: string;
  readonly documentType: PolicyDocumentType;
  /** Two-letter state code or `floor` (the brand's always-effective base). */
  readonly jurisdiction: string;
  readonly version: number;
  /** ISO `YYYY-MM-DD` (inclusive "on and after"). */
  readonly effectiveOn: string;
  readonly status: PolicyStatus;
  readonly counselSignoffRef?: string;
  readonly changeControlRef: string;
  /** Grammar-checked pointer into the document store — never the body. */
  readonly contentRef: string;
  /** sha-256 of the rendered body. */
  readonly contentHash: string;
  readonly synthetic: true;
}

function isPolicyDocumentType(value: string): value is PolicyDocumentType {
  return (policyDocumentTypes as readonly string[]).includes(value);
}

export function assertPolicyDocumentWellFormed(document: PolicyDocumentVersion): void {
  const label = `${document.tenantId}/${document.documentType}/${document.jurisdiction} v${document.version}`;
  if (!isPolicyDocumentType(document.documentType)) {
    throw new PolicyRegistryError(`policy ${label}: unknown document type`);
  }
  if (
    !stateCodePattern.test(document.jurisdiction) &&
    document.jurisdiction !== basePolicyJurisdiction
  ) {
    throw new PolicyRegistryError(
      `policy ${label}: jurisdiction must be a two-letter state code or '${basePolicyJurisdiction}'`,
    );
  }
  if (!Number.isInteger(document.version) || document.version < 1) {
    throw new PolicyRegistryError(`policy ${label}: version must be a positive integer`);
  }
  if (!isEffectiveDate(document.effectiveOn)) {
    throw new PolicyRegistryError(
      `policy ${label}: effectiveOn must be a calendar date (YYYY-MM-DD); ` +
        `received ${JSON.stringify(document.effectiveOn)}`,
    );
  }
  if (!changeRefPattern.test(document.changeControlRef)) {
    throw new PolicyRegistryError(
      `policy ${label}: requires a change-control reference (counsel-owned data fails closed)`,
    );
  }
  if (document.status === 'counsel-signed' && !document.counselSignoffRef) {
    throw new PolicyRegistryError(
      `policy ${label}: counsel-signed status requires a counsel sign-off reference (EW-025)`,
    );
  }
  if (!refPattern.test(document.contentRef)) {
    throw new PolicyRegistryError(
      `policy ${label}: contentRef ${JSON.stringify(document.contentRef)} is malformed`,
    );
  }
  if (!hashPattern.test(document.contentHash)) {
    throw new PolicyRegistryError(`policy ${label}: contentHash must be a sha-256 hex digest`);
  }
  if (document.synthetic !== true) {
    throw new PolicyRegistryError(`policy ${label}: missing the synthetic watermark`);
  }
}

/**
 * Validate a registry: every document well-formed, no duplicate
 * (tenant, type, jurisdiction, version), and — for every (tenant, documentType)
 * pair present — a `floor` base variant whose earliest version carries the epoch
 * sentinel, so resolution always has an always-effective fallback (a brand that
 * can render a disclosure can always render the base).
 */
export function assertPolicyRegistryWellFormed(documents: readonly PolicyDocumentVersion[]): void {
  const seen = new Set<string>();
  const pairs = new Set<string>();
  for (const document of documents) {
    assertPolicyDocumentWellFormed(document);
    const key = `${document.tenantId}|${document.documentType}|${document.jurisdiction}@${document.version}`;
    if (seen.has(key)) {
      throw new PolicyRegistryError(`duplicate policy document ${key}`);
    }
    seen.add(key);
    pairs.add(`${document.tenantId}|${document.documentType}`);
  }
  for (const pair of pairs) {
    const [tenantId, documentType] = pair.split('|');
    const baseVersions = documents.filter(
      (document) =>
        document.tenantId === tenantId &&
        document.documentType === documentType &&
        document.jurisdiction === basePolicyJurisdiction,
    );
    if (baseVersions.length === 0) {
      throw new PolicyRegistryError(
        `registry is missing the '${basePolicyJurisdiction}' base variant for ${pair} ` +
          '(a brand with no base policy cannot fall back)',
      );
    }
    const earliest = [...baseVersions].sort((left, right) => left.version - right.version)[0];
    if (earliest !== undefined && earliest.effectiveOn !== epochEffectiveOn) {
      throw new PolicyRegistryError(
        `${pair} base v${earliest.version}: the earliest base variant must carry the epoch ` +
          `sentinel ${epochEffectiveOn} (always-effective fallback)`,
      );
    }
  }
}

export interface PolicyDocumentResolution {
  readonly tenantId: string;
  readonly documentType: PolicyDocumentType;
  readonly jurisdiction: string;
  readonly version: number;
  readonly effectiveOn: string;
  readonly contentRef: string;
  readonly contentHash: string;
  readonly status: PolicyStatus;
  readonly counselReviewPending: boolean;
  /** The as-of date the selection used (explicit, or the current date). */
  readonly asOf: string;
  /** True when the state variant had no effective version and the base governed. */
  readonly fallbackToBase: boolean;
}

/**
 * Resolve the governing policy document as-of `asOf` (ADR-007 D3). Selection is
 * the SHARED effective-dating primitive over the (tenant, documentType,
 * jurisdiction) versions; when the state variant has no effective version the
 * brand's `floor` base governs; when neither exists it is a fail-closed error —
 * a brand cannot render a disclosure it has no policy for.
 */
export function resolvePolicyDocument(
  documents: readonly PolicyDocumentVersion[],
  tenantId: string,
  documentType: PolicyDocumentType,
  jurisdiction: string,
  asOf?: string,
): PolicyDocumentResolution {
  if (!isPolicyDocumentType(documentType)) {
    throw new PolicyRegistryError(`unknown policy document type ${JSON.stringify(documentType)}`);
  }
  if (jurisdiction !== basePolicyJurisdiction && !stateCodePattern.test(jurisdiction)) {
    throw new PolicyRegistryError(
      `jurisdiction must be a two-letter state code or '${basePolicyJurisdiction}'; ` +
        `received ${JSON.stringify(jurisdiction)}`,
    );
  }
  assertPolicyRegistryWellFormed(documents);
  const resolvedAsOf = resolveEffectiveAsOf(asOf);
  const forKey = (target: string): readonly PolicyDocumentVersion[] =>
    documents.filter(
      (document) =>
        document.tenantId === tenantId &&
        document.documentType === documentType &&
        document.jurisdiction === target,
    );

  let selected = selectEffectiveVersion(forKey(jurisdiction), resolvedAsOf);
  let fallbackToBase = false;
  if (selected === undefined && jurisdiction !== basePolicyJurisdiction) {
    selected = selectEffectiveVersion(forKey(basePolicyJurisdiction), resolvedAsOf);
    fallbackToBase = selected !== undefined;
  }
  if (selected === undefined) {
    throw new PolicyRegistryError(
      `no effective policy document for ${tenantId}/${documentType}/${jurisdiction} ` +
        `as-of ${resolvedAsOf} (fail-closed — no base variant either)`,
    );
  }
  return {
    tenantId,
    documentType,
    jurisdiction: selected.jurisdiction,
    version: selected.version,
    effectiveOn: selected.effectiveOn,
    contentRef: selected.contentRef,
    contentHash: selected.contentHash,
    status: selected.status,
    counselReviewPending: selected.status !== 'counsel-signed',
    asOf: resolvedAsOf,
    fallbackToBase,
  };
}

/**
 * The policy-version stamp a consent event's `policyVersion` and a rendered
 * disclosure record (ADR-007 D3 policy-version stamping) — deterministic and
 * grammar-safe for the consent ledger's `policyVersion` column.
 */
export function policyVersionStamp(
  resolution: Pick<PolicyDocumentResolution, 'documentType' | 'jurisdiction' | 'version'>,
): string {
  return `${resolution.documentType}:${resolution.jurisdiction}:v${resolution.version}`;
}
