import { RcmShadowError } from '../contracts.js';

import type { MspReason, Wp054MspDetermination } from './placeholders.js';
import type {
  CobFinding,
  CobOrder,
  Coverage,
  EpisodeInput,
  PayerKind,
  SequencedPayer,
} from './types.js';

const MEDICARE: readonly PayerKind[] = ['medicare', 'medicare-advantage'];
/** Group health plans for MSP purposes. `individual-commercial` is deliberately not one. */
const GROUP_HEALTH: readonly PayerKind[] = ['employer-ghp', 'commercial'];
const LIABILITY_KINDS: readonly PayerKind[] = ['workers-comp', 'no-fault', 'liability'];
const LIABILITY: Readonly<Partial<Record<MspReason, PayerKind>>> = {
  'workers-comp': 'workers-comp',
  'no-fault': 'no-fault',
  liability: 'liability',
};

/** Employer size at or above which the group health plan pays before Medicare. */
const GHP_PRIMARY_MIN_SIZE: Readonly<Partial<Record<MspReason, number>>> = {
  'working-aged': 20,
  disability: 100,
  'esrd-coordination': 1,
};

function effectiveOn(coverage: Coverage, day: string): boolean {
  return (
    coverage.effectiveFrom <= day && (coverage.effectiveTo === null || day <= coverage.effectiveTo)
  );
}

/**
 * Lower rank pays first. Medicaid is always the payer of last resort; Medigap always follows
 * Medicare; accident and work-injury payers lead for related services (and are not billed for
 * unrelated ones). Whether that lead is allowed alongside Medicare is checked in deriveCobOrder.
 */
function rank(
  coverage: Coverage,
  input: EpisodeInput,
  msp: Wp054MspDetermination | null,
): number | null {
  const reason = msp?.reason ?? 'none';
  if (LIABILITY_KINDS.includes(coverage.kind)) {
    return input.accidentRelated ? 0 : null;
  }
  if (MEDICARE.includes(coverage.kind)) return 20;
  if (coverage.kind === 'individual-commercial') return 30;
  if (GROUP_HEALTH.includes(coverage.kind)) {
    const minSize = GHP_PRIMARY_MIN_SIZE[reason];
    const size = msp?.employerSize ?? 0;
    return minSize !== undefined && size >= minSize ? 10 : 30;
  }
  switch (coverage.kind) {
    case 'retiree-ghp':
      return 30;
    case 'tricare':
      return 40;
    case 'medigap':
      return 50;
    case 'medicaid':
      return 90;
    default:
      return null;
  }
}

function assertDetermination(input: EpisodeInput, msp: Wp054MspDetermination | null): void {
  if (msp === null) return;
  if (msp.tenantId !== input.tenantId || msp.patientId !== input.patientId) {
    throw new RcmShadowError('COB_MSP_SCOPE', 'MSP determination belongs to another patient');
  }
  if (msp.reason in GHP_PRIMARY_MIN_SIZE && (msp.employerSize === null || msp.employerSize < 0)) {
    throw new RcmShadowError('COB_MSP', `MSP reason ${msp.reason} needs an employer size`);
  }
}

/**
 * Derives the payer order for one episode of service from its coverages and the MSP determination
 * (R6-REQ-030). Pure: the same inputs always give the same order.
 */
export function deriveCobOrder(input: EpisodeInput, msp: Wp054MspDetermination | null): CobOrder {
  assertDetermination(input, msp);
  const blocking: CobFinding[] = [];
  const active = input.coverages.filter(
    (coverage) =>
      coverage.tenantId === input.tenantId &&
      coverage.patientId === input.patientId &&
      effectiveOn(coverage, input.serviceDate),
  );
  const medicare = active.filter((coverage) => MEDICARE.includes(coverage.kind));
  if (medicare.length > 1) {
    blocking.push({
      flag: 'multiple-medicare-coverages',
      detail: 'Original Medicare and Medicare Advantage cannot both be active on the service date',
    });
  }
  if (medicare.length === 0 && active.some((coverage) => coverage.kind === 'medigap')) {
    blocking.push({
      flag: 'medigap-without-medicare',
      detail: 'Medigap is active without Medicare',
    });
  }
  const needsMsp =
    medicare.length > 0 &&
    active.some(
      (coverage) =>
        coverage.kind !== 'medigap' &&
        coverage.kind !== 'medicaid' &&
        !MEDICARE.includes(coverage.kind),
    );
  if (needsMsp && msp === null) {
    blocking.push({
      flag: 'msp-determination-missing',
      detail: 'Medicare plus another payer requires an MSP determination before any claim',
    });
  }
  if (input.accidentRelated && medicare.length > 0 && msp !== null) {
    const allowed = LIABILITY[msp.reason];
    for (const coverage of active.filter(
      (c) => LIABILITY_KINDS.includes(c.kind) && c.kind !== allowed,
    )) {
      blocking.push({
        flag: 'msp-liability-conflict',
        detail: `${coverage.kind} coverage ${coverage.coverageId} is active for an accident-related episode but MSP reason is ${msp.reason}`,
      });
    }
  }
  if (msp !== null && input.serviceDate > msp.validThrough) {
    blocking.push({
      flag: 'msp-determination-stale',
      detail: `MSP determination ${msp.determinationId} ended ${msp.validThrough}, before service`,
    });
  }

  const ranked = active
    .map((coverage) => ({ coverage, value: rank(coverage, input, msp) }))
    .filter((entry): entry is { coverage: Coverage; value: number } => entry.value !== null)
    .sort(
      (a, b) => a.value - b.value || a.coverage.coverageId.localeCompare(b.coverage.coverageId),
    );
  if (ranked.length === 0) {
    blocking.push({ flag: 'no-payable-coverage', detail: 'no coverage pays for this service' });
  }
  // Only coverages the order includes are addressed by payer; an excluded coverage
  // (for example an unrelated liability policy) cannot collide with a billed one (NR-159).
  const payerIds = new Map<string, string>();
  for (const { coverage } of ranked) {
    const other = payerIds.get(coverage.payerId);
    if (other !== undefined) {
      blocking.push({
        flag: 'duplicate-payer',
        detail: `coverages ${other} and ${coverage.coverageId} share payer ${coverage.payerId}; claims are addressed by payer`,
      });
    }
    payerIds.set(coverage.payerId, coverage.coverageId);
  }
  const payers: SequencedPayer[] = ranked.map(({ coverage }, position) =>
    Object.freeze({
      position,
      coverageId: coverage.coverageId,
      payerId: coverage.payerId,
      kind: coverage.kind,
      crossoverEligible: coverage.crossoverEligible,
    }),
  );
  const basis =
    msp === null
      ? 'no MSP determination'
      : `MSP ${msp.determinationId} reason ${msp.reason} employerSize ${String(msp.employerSize ?? 'n/a')}`;
  return Object.freeze({ payers: Object.freeze(payers), blocking: Object.freeze(blocking), basis });
}
