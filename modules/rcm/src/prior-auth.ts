/**
 * WP-082 prior-authorization and referral requirements.
 *
 * A versioned rule table says, per tenant, payer and service code, whether a
 * service needs a prior authorization, a referral, both or neither, for a
 * given service date. Authorization records carry status, a validity window
 * and approved units. `checkAuthorization` decides one encounter or claim
 * line: clear, blocked (a requirement is unmet) or hold (the requirement
 * itself is unknown or ambiguous, so nothing is assumed).
 */

import { RcmShadowError } from './contracts.js';

export type AuthorizationKind = 'prior-auth' | 'referral';

export type AuthorizationRequirement = 'none' | 'prior-auth' | 'referral' | 'both';

export interface AuthorizationRequirementRule {
  readonly tenantId: string;
  readonly payerRef: string;
  /** CPT/HCPCS code, or `rx:<id>` for a medication. */
  readonly serviceCode: string;
  readonly requirement: AuthorizationRequirement;
  /** YYYY-MM-DD, inclusive. */
  readonly effectiveFrom: string;
  /** YYYY-MM-DD, inclusive; null while current. */
  readonly effectiveTo: string | null;
  readonly ruleVersionRef: string;
}

export type AuthorizationStatus =
  'requested' | 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface AuthorizationRecord {
  readonly authRef: string;
  readonly tenantId: string;
  readonly patientRef: string;
  readonly payerRef: string;
  readonly kind: AuthorizationKind;
  readonly serviceCodes: readonly string[];
  readonly status: AuthorizationStatus;
  /** YYYY-MM-DD, inclusive. */
  readonly validFrom: string;
  /** YYYY-MM-DD, inclusive. */
  readonly validTo: string;
  /** null when the authorization is not unit-limited. */
  readonly unitsApproved: number | null;
  readonly unitsUsed: number;
  /** Set when the record comes from an interim system of record (e.g. athena). */
  readonly interimSource: string | null;
}

export interface AuthorizationLine {
  readonly tenantId: string;
  readonly patientRef: string;
  readonly payerRef: string;
  readonly serviceCode: string;
  /** YYYY-MM-DD. */
  readonly serviceDate: string;
  readonly units: number;
}

export interface RequirementLookup {
  readonly requirement: AuthorizationRequirement | 'unknown';
  readonly ruleVersionRefs: readonly string[];
  readonly ambiguous: boolean;
  /** Rules for this line whose dates are malformed; any one makes the requirement unknown. */
  readonly invalidRuleRefs?: readonly string[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict YYYY-MM-DD: the shape and a calendar round-trip ('2026-02-30' and '2026-6-1' fail). */
export function isValidAuthorizationDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function assertDate(value: string, name: string): void {
  if (!isValidAuthorizationDate(value))
    throw new RcmShadowError('PA_INPUT', `${name} must be a valid YYYY-MM-DD date`);
}

const ruleDatesValid = (rule: AuthorizationRequirementRule): boolean =>
  isValidAuthorizationDate(rule.effectiveFrom) &&
  (rule.effectiveTo === null || isValidAuthorizationDate(rule.effectiveTo));

const recordDatesValid = (record: AuthorizationRecord): boolean =>
  isValidAuthorizationDate(record.validFrom) && isValidAuthorizationDate(record.validTo);

const kindsFor = (requirement: AuthorizationRequirement): readonly AuthorizationKind[] =>
  requirement === 'both' ? ['prior-auth', 'referral'] : requirement === 'none' ? [] : [requirement];

export function lookupRequirement(
  rules: readonly AuthorizationRequirementRule[],
  line: Pick<AuthorizationLine, 'tenantId' | 'payerRef' | 'serviceCode' | 'serviceDate'>,
): RequirementLookup {
  assertDate(line.serviceDate, 'serviceDate');
  const forLine = rules.filter(
    (rule) =>
      rule.tenantId === line.tenantId &&
      rule.payerRef === line.payerRef &&
      rule.serviceCode === line.serviceCode,
  );
  // A malformed rule date cannot be compared safely, so the requirement is unknown (HOLD).
  const invalidRuleRefs = forLine
    .filter((rule) => !ruleDatesValid(rule))
    .map((rule) => rule.ruleVersionRef)
    .sort();
  if (invalidRuleRefs.length > 0) {
    return {
      requirement: 'unknown',
      ruleVersionRefs: invalidRuleRefs,
      ambiguous: false,
      invalidRuleRefs,
    };
  }
  const matching = forLine.filter(
    (rule) =>
      rule.effectiveFrom <= line.serviceDate &&
      (rule.effectiveTo === null || line.serviceDate <= rule.effectiveTo),
  );
  if (matching.length === 0)
    return { requirement: 'unknown', ruleVersionRefs: [], ambiguous: false };
  const requirements = new Set(matching.map((rule) => rule.requirement));
  const refs = matching.map((rule) => rule.ruleVersionRef).sort();
  if (requirements.size > 1) {
    // Overlapping rules that disagree: demand everything any of them demands.
    const kinds = new Set(matching.flatMap((rule) => kindsFor(rule.requirement)));
    const requirement: AuthorizationRequirement =
      kinds.size === 2
        ? 'both'
        : kinds.has('prior-auth')
          ? 'prior-auth'
          : kinds.has('referral')
            ? 'referral'
            : 'none';
    return { requirement, ruleVersionRefs: refs, ambiguous: true };
  }
  const [only] = requirements;
  return { requirement: only ?? 'unknown', ruleVersionRefs: refs, ambiguous: false };
}

export interface AuthorizationDecision {
  readonly outcome: 'clear' | 'blocked' | 'hold';
  readonly requirement: AuthorizationRequirement | 'unknown';
  readonly reasons: readonly string[];
  /** The records that satisfy the line, one per required kind. */
  readonly authRefs: readonly string[];
  readonly ruleVersionRefs: readonly string[];
}

function unmetReason(
  kind: AuthorizationKind,
  candidates: readonly AuthorizationRecord[],
  line: AuthorizationLine,
): string {
  if (candidates.length === 0) return `${kind}-missing`;
  const statuses = new Set(candidates.map((record) => record.status));
  if (statuses.has('approved')) {
    const approved = candidates.filter((record) => record.status === 'approved');
    const covering = approved.filter(
      (record) => record.validFrom <= line.serviceDate && line.serviceDate <= record.validTo,
    );
    if (covering.length > 0) return `${kind}-units-exhausted`;
    if (approved.every((record) => record.validFrom > line.serviceDate))
      return `${kind}-not-yet-valid`;
    if (approved.every((record) => record.validTo < line.serviceDate)) return `${kind}-expired`;
    // Approvals before and after the service date, none covering it.
    return `${kind}-not-valid-on-service-date`;
  }
  if (statuses.has('pending') || statuses.has('requested')) return `${kind}-pending`;
  if (statuses.has('denied')) return `${kind}-denied`;
  if (statuses.has('expired')) return `${kind}-expired`;
  return `${kind}-cancelled`;
}

export function checkAuthorization(input: {
  readonly rules: readonly AuthorizationRequirementRule[];
  readonly records: readonly AuthorizationRecord[];
  readonly line: AuthorizationLine;
}): AuthorizationDecision {
  const { line } = input;
  if (!Number.isSafeInteger(line.units) || line.units <= 0) {
    throw new RcmShadowError('PA_INPUT', 'units must be a positive integer');
  }
  const lookup = lookupRequirement(input.rules, line);
  if (lookup.requirement === 'unknown') {
    const invalid = lookup.invalidRuleRefs ?? [];
    return {
      outcome: 'hold',
      requirement: 'unknown',
      reasons:
        invalid.length > 0 ? ['requirement-unknown', 'rule-date-invalid'] : ['requirement-unknown'],
      authRefs: [],
      ruleVersionRefs: invalid,
    };
  }
  const reasons: string[] = lookup.ambiguous ? ['requirement-rules-conflict'] : [];
  const authRefs: string[] = [];
  let definiteUnmet = false;
  for (const kind of kindsFor(lookup.requirement)) {
    const matched = input.records.filter(
      (record) =>
        record.kind === kind &&
        record.tenantId === line.tenantId &&
        record.patientRef === line.patientRef &&
        record.payerRef === line.payerRef &&
        record.serviceCodes.includes(line.serviceCode),
    );
    // A record with a malformed date is never usable and never compared as a string.
    const malformed = matched.filter((record) => !recordDatesValid(record));
    const candidates = matched.filter(recordDatesValid);
    const usable = candidates.find(
      (record) =>
        record.status === 'approved' &&
        record.validFrom <= line.serviceDate &&
        line.serviceDate <= record.validTo &&
        (record.unitsApproved === null || record.unitsApproved - record.unitsUsed >= line.units),
    );
    if (usable !== undefined) {
      authRefs.push(usable.authRef);
    } else if (malformed.length > 0) {
      // Unknown, not unmet: HOLD until the record's dates are corrected.
      reasons.push(`${kind}-record-date-invalid`);
    } else {
      definiteUnmet = true;
      reasons.push(unmetReason(kind, candidates, line));
    }
  }
  const unmet = authRefs.length < kindsFor(lookup.requirement).length;
  const blocked = unmet && definiteUnmet;
  return {
    outcome: blocked ? 'blocked' : unmet || lookup.ambiguous ? 'hold' : 'clear',
    requirement: lookup.requirement,
    reasons,
    authRefs: blocked ? [] : authRefs,
    ruleVersionRefs: lookup.ruleVersionRefs,
  };
}

/** Record units used against an approved, unit-limited authorization. */
export function consumeAuthorizationUnits(
  record: AuthorizationRecord,
  units: number,
): AuthorizationRecord {
  if (!Number.isSafeInteger(units) || units <= 0) {
    throw new RcmShadowError('PA_INPUT', 'units must be a positive integer');
  }
  if (record.status !== 'approved') {
    throw new RcmShadowError('PA_STATE', 'only an approved authorization can be consumed');
  }
  if (record.unitsApproved !== null && record.unitsUsed + units > record.unitsApproved) {
    throw new RcmShadowError('PA_UNITS', 'authorization units would be exceeded');
  }
  return { ...record, unitsUsed: record.unitsUsed + units };
}
