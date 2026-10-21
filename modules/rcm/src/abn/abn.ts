/**
 * WP-094 ABN lifecycle (R6-REQ-033; REQ-RCM-001).
 *
 * An Advance Beneficiary Notice is prepared, delivered and signed (or its
 * refusal witnessed) before the service. Validity is judged only against
 * evidence recorded at or before the service instant, so nothing done after
 * the service can cure a missing, late or defective notice: that case
 * suppresses transfer of liability and escalates.
 */

export type AbnOption =
  'option-1-bill-medicare' | 'option-2-do-not-bill' | 'option-3-decline-service';

export type AbnStatus = 'draft' | 'delivered' | 'signed' | 'refused-witnessed' | 'voided';

export interface AbnRecord {
  readonly abnRef: string;
  readonly tenantId: string;
  readonly patientRef: string;
  readonly serviceRef: string;
  readonly formVersionRef: string;
  readonly reasonText: string;
  readonly estimateMinor: number | null;
  readonly option: AbnOption | null;
  readonly status: AbnStatus;
  readonly preparedAt: string;
  readonly deliveredAt: string | null;
  readonly signedAt: string | null;
  readonly refusalWitnessRef: string | null;
  readonly patientCopyDeliveredAt: string | null;
  readonly accessibilityFormatRef: string | null;
  readonly voidReason: string | null;
  readonly synthetic: true;
}

export class AbnError extends Error {
  public constructor(
    public readonly code:
      | 'ABN_NOT_DRAFT'
      | 'ABN_NOT_DELIVERED'
      | 'ABN_OPTION_REQUIRED'
      | 'ABN_WITNESS_REQUIRED'
      | 'ABN_VOID_REASON_REQUIRED'
      | 'ABN_ALREADY_VOIDED'
      | 'RETROACTIVE_CURE_REFUSED'
      | 'ABN_INVALID_INSTANT',
  ) {
    super(code);
    this.name = 'AbnError';
  }
}

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Epoch milliseconds for a full ISO 8601 instant with a zone, or null.
 * Instants are compared numerically, never as strings: precision and offset
 * change the lexical order (a later signature can sort earlier). Every field
 * is calendar-checked, so an impossible date such as 02-30 or hour 24 is
 * refused instead of rolling over into another day (NR-155).
 */
export function parseAbnInstant(value: string): number | null {
  const match = ISO_INSTANT.exec(value);
  if (match === null) return null;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match
    .slice(1)
    .map((part) => (part === undefined ? 0 : Number(part)));
  const calendarDay = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
  if (
    calendarDay.getUTCFullYear() !== year ||
    calendarDay.getUTCMonth() !== (month ?? 0) - 1 ||
    calendarDay.getUTCDate() !== day ||
    (hour ?? 0) > 23 ||
    (minute ?? 0) > 59 ||
    (second ?? 0) > 59 ||
    (offsetHour ?? 0) > 23 ||
    (offsetMinute ?? 0) > 59
  ) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function requireInstant(value: string): number {
  const ms = parseAbnInstant(value);
  if (ms === null) throw new AbnError('ABN_INVALID_INSTANT');
  return ms;
}

export function prepareAbn(input: {
  readonly abnRef: string;
  readonly tenantId: string;
  readonly patientRef: string;
  readonly serviceRef: string;
  readonly formVersionRef: string;
  readonly reasonText: string;
  readonly estimateMinor: number | null;
  readonly preparedAt: string;
  readonly accessibilityFormatRef?: string;
  /** When the service was already rendered, any notice would be a retroactive cure. */
  readonly serviceRenderedAt?: string;
}): AbnRecord {
  const preparedMs = requireInstant(input.preparedAt);
  if (
    input.serviceRenderedAt !== undefined &&
    requireInstant(input.serviceRenderedAt) <= preparedMs
  ) {
    throw new AbnError('RETROACTIVE_CURE_REFUSED');
  }
  return {
    abnRef: input.abnRef,
    tenantId: input.tenantId,
    patientRef: input.patientRef,
    serviceRef: input.serviceRef,
    formVersionRef: input.formVersionRef,
    reasonText: input.reasonText,
    estimateMinor: input.estimateMinor,
    option: null,
    status: 'draft',
    preparedAt: input.preparedAt,
    deliveredAt: null,
    signedAt: null,
    refusalWitnessRef: null,
    patientCopyDeliveredAt: null,
    accessibilityFormatRef: input.accessibilityFormatRef ?? null,
    voidReason: null,
    synthetic: true,
  };
}

export function deliverAbn(abn: AbnRecord, at: string): AbnRecord {
  if (abn.status !== 'draft') throw new AbnError('ABN_NOT_DRAFT');
  requireInstant(at);
  return { ...abn, status: 'delivered', deliveredAt: at };
}

export function signAbn(
  abn: AbnRecord,
  input: {
    readonly option: AbnOption | null;
    readonly at: string;
    readonly copyDeliveredAt: string | null;
  },
): AbnRecord {
  if (abn.status !== 'delivered') throw new AbnError('ABN_NOT_DELIVERED');
  if (input.option === null) throw new AbnError('ABN_OPTION_REQUIRED');
  requireInstant(input.at);
  if (input.copyDeliveredAt !== null) requireInstant(input.copyDeliveredAt);
  return {
    ...abn,
    status: 'signed',
    option: input.option,
    signedAt: input.at,
    patientCopyDeliveredAt: input.copyDeliveredAt,
  };
}

/** Policy-valid refusal: witnessed, copy delivered; no consent is invented. */
export function recordRefusal(
  abn: AbnRecord,
  input: {
    readonly witnessRef: string;
    readonly at: string;
    readonly copyDeliveredAt: string | null;
  },
): AbnRecord {
  if (abn.status !== 'delivered') throw new AbnError('ABN_NOT_DELIVERED');
  if (input.witnessRef.trim() === '') throw new AbnError('ABN_WITNESS_REQUIRED');
  requireInstant(input.at);
  if (input.copyDeliveredAt !== null) requireInstant(input.copyDeliveredAt);
  return {
    ...abn,
    status: 'refused-witnessed',
    option: null,
    signedAt: input.at,
    refusalWitnessRef: input.witnessRef,
    patientCopyDeliveredAt: input.copyDeliveredAt,
  };
}

/** An ABN issued in error is voided with a reason and retained, never deleted. */
export function voidAbn(abn: AbnRecord, reason: string): AbnRecord {
  if (abn.status === 'voided') throw new AbnError('ABN_ALREADY_VOIDED');
  if (reason.trim() === '') throw new AbnError('ABN_VOID_REASON_REQUIRED');
  return { ...abn, status: 'voided', voidReason: reason };
}

export type AbnDefect =
  | 'missing'
  | 'voided'
  | 'not-executed'
  | 'late'
  | 'unapproved-form'
  | 'nonspecific-reason'
  | 'estimate-missing'
  | 'option-missing'
  | 'patient-copy-missing'
  | 'cross-patient'
  | 'cross-service'
  | 'invalid-instant';

export interface AbnValidity {
  readonly valid: boolean;
  readonly defects: readonly AbnDefect[];
  /** `signed` transfers liability per the option; `refused` only permits self-pay-at-risk. */
  readonly evidence: 'signed' | 'refused' | 'none';
  /** The option the patient signed on this ABN; null unless the ABN is valid and signed. */
  readonly option: AbnOption | null;
}

const genericReasons = [
  'may not be covered',
  'medicare may not pay',
  'not covered',
  'medically unnecessary',
  'n/a',
];

/**
 * Judge an ABN for one service. Only facts dated at or before `serviceAt`
 * count, so a signature, copy or fix recorded afterwards never cures it.
 */
export function evaluateAbnValidity(input: {
  readonly abn: AbnRecord | null;
  readonly tenantId: string;
  readonly patientRef: string;
  readonly serviceRef: string;
  readonly serviceAt: string;
  readonly approvedFormVersionRefs: readonly string[];
}): AbnValidity {
  const { abn } = input;
  if (abn === null) return { valid: false, defects: ['missing'], evidence: 'none', option: null };
  const defects: AbnDefect[] = [];
  const serviceMs = parseAbnInstant(input.serviceAt);
  const preparedMs = parseAbnInstant(abn.preparedAt);
  const optional = (value: string | null): number | null | 'invalid' =>
    value === null ? null : (parseAbnInstant(value) ?? 'invalid');
  const deliveredMs = optional(abn.deliveredAt);
  const signedMs = optional(abn.signedAt);
  const copyMs = optional(abn.patientCopyDeliveredAt);
  if (
    serviceMs === null ||
    preparedMs === null ||
    deliveredMs === 'invalid' ||
    signedMs === 'invalid' ||
    copyMs === 'invalid'
  ) {
    defects.push('invalid-instant');
  }
  const after = (ms: number | null | 'invalid'): boolean =>
    typeof ms === 'number' && serviceMs !== null && ms > serviceMs;
  if (abn.tenantId !== input.tenantId || abn.patientRef !== input.patientRef) {
    defects.push('cross-patient');
  }
  if (abn.serviceRef !== input.serviceRef) defects.push('cross-service');
  if (abn.status === 'voided') defects.push('voided');
  const executed = abn.status === 'signed' || abn.status === 'refused-witnessed';
  if (!executed && abn.status !== 'voided') defects.push('not-executed');
  if (after(preparedMs) || after(deliveredMs) || after(signedMs)) {
    defects.push('late');
  }
  if (!input.approvedFormVersionRefs.includes(abn.formVersionRef)) defects.push('unapproved-form');
  const reason = abn.reasonText.trim().toLowerCase();
  if (reason.length < 20 || genericReasons.includes(reason)) defects.push('nonspecific-reason');
  if (
    abn.estimateMinor === null ||
    !Number.isSafeInteger(abn.estimateMinor) ||
    abn.estimateMinor < 0
  ) {
    defects.push('estimate-missing');
  }
  if (abn.status === 'signed' && abn.option === null) defects.push('option-missing');
  if (executed && (copyMs === null || after(copyMs))) {
    defects.push('patient-copy-missing');
  }
  const unique = [...new Set(defects)];
  const valid = unique.length === 0;
  return {
    valid,
    defects: unique,
    evidence: !valid ? 'none' : abn.status === 'signed' ? 'signed' : 'refused',
    option: valid && abn.status === 'signed' ? abn.option : null,
  };
}

export type ServiceGate =
  | {
      readonly proceed: true;
      readonly basis: 'abn-not-required' | 'valid-abn' | 'self-pay-at-risk' | 'emergency-exception';
    }
  | {
      readonly proceed: false;
      readonly reason: 'valid-abn-required' | 'patient-declined-service' | 'option-mismatch';
      readonly escalate: boolean;
    };

/**
 * No service proceeds without a valid ABN when one is required. Emergency care
 * proceeds through the approved exception, and liability is never inferred
 * from the missing notice.
 */
export function evaluateServiceGate(input: {
  readonly abnRequired: boolean;
  readonly validity: AbnValidity;
  /**
   * Optional cross-check only. The option always comes from the signed ABN
   * (`validity.option`); a different caller-supplied option is refused.
   */
  readonly option?: AbnOption | null;
  readonly emergencyException: boolean;
}): ServiceGate {
  if (!input.abnRequired) return { proceed: true, basis: 'abn-not-required' };
  if (input.emergencyException) return { proceed: true, basis: 'emergency-exception' };
  if (!input.validity.valid)
    return { proceed: false, reason: 'valid-abn-required', escalate: true };
  if (input.option !== undefined && input.option !== input.validity.option) {
    return { proceed: false, reason: 'option-mismatch', escalate: true };
  }
  if (input.validity.evidence === 'refused') return { proceed: true, basis: 'self-pay-at-risk' };
  if (input.validity.option === 'option-3-decline-service') {
    return { proceed: false, reason: 'patient-declined-service', escalate: false };
  }
  return { proceed: true, basis: 'valid-abn' };
}
