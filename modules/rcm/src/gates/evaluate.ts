import { createHash } from 'node:crypto';

import { RcmShadowError } from '../contracts.js';

import type {
  ShadowConcordance,
  Wp088DenialOutcome,
  Wp089PostingOutcome,
  Wp091EnrollmentCheck,
} from './placeholders.js';
import { wilsonInterval, type GateConfidence, type WilsonInterval } from './stats.js';

/** The four promotion gates. Every one must pass for a payer to reach shadow-ready. */
export type GateId =
  'claim-concordance' | 'denial-free' | 'posting-reconciliation' | 'enrollment-liveness';

export const GATE_IDS: readonly GateId[] = [
  'claim-concordance',
  'denial-free',
  'posting-reconciliation',
  'enrollment-liveness',
];

export type ObservationOutcome = 'success' | 'failure' | 'pending';

export interface GateObservation {
  readonly observationId: string;
  readonly gateId: GateId;
  readonly tenantId: string;
  readonly payerId: string;
  /** Seal token of the sealed record the outcome came from. Unsealed data cannot enter a gate. */
  readonly seal: string;
  readonly eventAt: string;
  readonly outcome: ObservationOutcome;
  /** A critical failure fails its gate outright, whatever the rate. */
  readonly critical: boolean;
  readonly subgroups: Readonly<Record<string, string>>;
}

/** Pre-registered before its cohort began; the plan fixes the denominator rules. */
export interface GatePlan {
  readonly gateId: GateId;
  /** The confidence LOWER bound of the success rate must reach this. */
  readonly threshold: number;
  readonly confidence: GateConfidence;
  /** Minimum mature, comparable observations per cell (aggregate and every subgroup). */
  readonly minSample: number;
  /** An outcome counts only once its event is at least this old. */
  readonly maturityDays: number;
  readonly subgroupKeys: readonly string[];
  readonly registeredAt: string;
}

export type GateVerdict = 'pass' | 'fail' | 'insufficient';

export interface GateCell {
  /** `all`, or `key=value` for a subgroup. */
  readonly cell: string;
  readonly interval: WilsonInterval;
  readonly criticalFailures: number;
  readonly verdict: GateVerdict;
}

export interface GateResult {
  readonly gateId: GateId;
  readonly scope: string;
  readonly verdict: GateVerdict;
  readonly aggregate: GateCell;
  readonly subgroups: readonly GateCell[];
  /** Subgroup cells that fail while the aggregate passes: shown, never averaged away. */
  readonly maskedFailures: readonly string[];
  readonly immature: number;
  readonly overduePending: number;
}

export interface PayerVerdict {
  readonly payerId: string;
  readonly verdict: GateVerdict;
  readonly gates: readonly GateResult[];
}

export interface PromotionDossier {
  readonly tenantId: string;
  readonly computedAt: string;
  readonly computedBy: string;
  readonly verdict: GateVerdict;
  readonly gates: readonly GateResult[];
  readonly payers: readonly PayerVerdict[];
  /** sha256 over the canonical dossier content (every field above). */
  readonly digest: string;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * Dossiers produced by evaluatePromotion in this process. A dossier is honoured only when it is
 * one of these exact (deep-frozen) objects and its digest still matches its content, so a
 * hand-built or copied dossier can never stand in for a gate evaluation.
 */
const issuedDossiers = new WeakSet<PromotionDossier>();

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function dossierDigest(dossier: Omit<PromotionDossier, 'digest'>): string {
  return createHash('sha256').update(canonical(dossier)).digest('hex');
}

/** True only for an unmodified dossier issued by evaluatePromotion. */
export function isIssuedDossier(dossier: PromotionDossier): boolean {
  if (!issuedDossiers.has(dossier)) {
    return false;
  }
  const { digest, ...content } = dossier;
  return digest === dossierDigest(content);
}
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DAY_MS = 86_400_000;
const MISSING = '(missing)';

export function parseGateInstant(value: string, code: string): number {
  if (!INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new RcmShadowError(code, 'timestamp must be YYYY-MM-DDTHH:MM:SSZ');
  }
  return Date.parse(value);
}

function worst(verdicts: readonly GateVerdict[]): GateVerdict {
  if (verdicts.includes('fail')) {
    return 'fail';
  }
  if (verdicts.includes('insufficient')) {
    return 'insufficient';
  }
  return 'pass';
}

function assertPlan(plan: GatePlan): void {
  if (!GATE_IDS.includes(plan.gateId)) {
    throw new RcmShadowError('GATE_PLAN', 'unknown gate');
  }
  if (!(plan.threshold > 0 && plan.threshold <= 1)) {
    throw new RcmShadowError('GATE_PLAN', 'threshold must be in (0, 1]');
  }
  if (!Number.isSafeInteger(plan.minSample) || plan.minSample < 1) {
    throw new RcmShadowError('GATE_PLAN', 'minSample must be a positive whole number');
  }
  if (!Number.isSafeInteger(plan.maturityDays) || plan.maturityDays < 0) {
    throw new RcmShadowError('GATE_PLAN', 'maturityDays must be a non-negative whole number');
  }
  if (
    new Set(plan.subgroupKeys).size !== plan.subgroupKeys.length ||
    plan.subgroupKeys.includes('payer')
  ) {
    throw new RcmShadowError(
      'GATE_PLAN',
      'subgroup keys must be unique; payer is always a subgroup',
    );
  }
  parseGateInstant(plan.registeredAt, 'GATE_PLAN');
}

interface Tally {
  successes: number;
  n: number;
  critical: number;
}

function cellOf(name: string, tally: Tally, plan: GatePlan): GateCell {
  const interval = wilsonInterval(tally.successes, tally.n, plan.confidence);
  const verdict: GateVerdict =
    tally.critical > 0
      ? 'fail'
      : tally.n < plan.minSample
        ? 'insufficient'
        : interval.lower >= plan.threshold
          ? 'pass'
          : 'fail';
  return { cell: name, interval, criticalFailures: tally.critical, verdict };
}

/**
 * Evaluates one gate. Every observation passed in is counted: there is no filter, so a failure
 * cannot be excluded and the denominator cannot be changed after the plan was registered.
 * A pending outcome past the maturity window counts as a failure.
 */
export function evaluateGate(
  plan: GatePlan,
  observations: readonly GateObservation[],
  now: string,
  scope = 'all-payers',
): GateResult {
  assertPlan(plan);
  const nowMs = parseGateInstant(now, 'GATE_NOW');
  const registeredMs = Date.parse(plan.registeredAt);
  if (registeredMs > nowMs) {
    throw new RcmShadowError('GATE_PLAN', 'plan is registered after the evaluation instant');
  }
  const matureBefore = nowMs - plan.maturityDays * DAY_MS;
  const ids = new Set<string>();
  const aggregate: Tally = { successes: 0, n: 0, critical: 0 };
  const cells = new Map<string, Tally>();
  let immature = 0;
  let overduePending = 0;
  let tenantId: string | null = null;

  for (const observation of observations) {
    if (observation.gateId !== plan.gateId) {
      throw new RcmShadowError(
        'GATE_OBSERVATION',
        `a ${observation.gateId} observation cannot enter ${plan.gateId}`,
      );
    }
    if (!TOKEN.test(observation.observationId) || ids.has(observation.observationId)) {
      throw new RcmShadowError('GATE_OBSERVATION', 'observation ids must be unique tokens');
    }
    ids.add(observation.observationId);
    if (!TOKEN.test(observation.payerId)) {
      throw new RcmShadowError('GATE_OBSERVATION', 'payerId must be a token');
    }
    if (!TOKEN.test(observation.tenantId)) {
      throw new RcmShadowError('GATE_TENANT', 'tenantId must be a token');
    }
    if (tenantId === null) {
      tenantId = observation.tenantId;
    } else if (observation.tenantId !== tenantId) {
      throw new RcmShadowError('GATE_TENANT', 'one gate evaluation covers one tenant');
    }
    // A seal is a token (no blanks, no whitespace). Verifying it against the WP-085 seal store
    // is left to the binding that supplies sealed records.
    if (!TOKEN.test(observation.seal)) {
      throw new RcmShadowError(
        'GATE_UNSEALED',
        'gates read sealed data only: seal must be a token',
      );
    }
    const eventMs = parseGateInstant(observation.eventAt, 'GATE_OBSERVATION');
    if (eventMs > nowMs) {
      throw new RcmShadowError('GATE_OBSERVATION', 'observation is after the evaluation instant');
    }
    if (eventMs < registeredMs) {
      throw new RcmShadowError('GATE_PLAN_LATE', 'plan was registered after its cohort began');
    }
    const mature = eventMs <= matureBefore;
    let success: boolean;
    if (!mature) {
      immature += 1;
      if (!(observation.outcome === 'failure' && observation.critical)) {
        continue;
      }
      // A critical failure counts the moment it happens; it is never deferred by maturity.
      success = false;
    } else if (observation.outcome === 'pending') {
      overduePending += 1;
      success = false;
    } else {
      success = observation.outcome === 'success';
    }
    const critical = !success && observation.critical ? 1 : 0;
    const names = [
      `payer=${observation.payerId}`,
      ...plan.subgroupKeys.map((key) => `${key}=${observation.subgroups[key] ?? MISSING}`),
    ];
    for (const tally of [
      aggregate,
      ...names.map((name) => {
        let cell = cells.get(name);
        if (!cell) {
          cell = { successes: 0, n: 0, critical: 0 };
          cells.set(name, cell);
        }
        return cell;
      }),
    ]) {
      tally.n += 1;
      tally.successes += success ? 1 : 0;
      tally.critical += critical;
    }
  }

  const aggregateCell = cellOf('all', aggregate, plan);
  const subgroupCells = [...cells.entries()]
    .map(([name, tally]) => cellOf(name, tally, plan))
    .sort((left, right) => left.cell.localeCompare(right.cell));
  const maskedFailures =
    aggregateCell.verdict === 'pass'
      ? subgroupCells.filter((cell) => cell.verdict === 'fail').map((cell) => cell.cell)
      : [];
  return {
    gateId: plan.gateId,
    scope,
    verdict: worst([aggregateCell.verdict, ...subgroupCells.map((cell) => cell.verdict)]),
    aggregate: aggregateCell,
    subgroups: subgroupCells,
    maskedFailures,
    immature,
    overduePending,
  };
}

/**
 * Builds the promotion dossier from sealed observations: the four gates across all payers, then
 * the four gates per payer. A payer's verdict is the worst of its gates; the dossier verdict is
 * the worst of everything. Insufficient evidence blocks exactly like a failure.
 */
export function evaluatePromotion(
  tenantId: string,
  plans: readonly GatePlan[],
  observations: readonly GateObservation[],
  now: string,
  computedBy: string,
): PromotionDossier {
  if (!TOKEN.test(computedBy)) {
    throw new RcmShadowError('GATE_DOSSIER', 'computedBy must be a token');
  }
  if (!TOKEN.test(tenantId)) {
    throw new RcmShadowError('GATE_TENANT', 'tenantId must be a token');
  }
  if (observations.some((item) => item.tenantId !== tenantId)) {
    throw new RcmShadowError('GATE_TENANT', `every observation must belong to tenant ${tenantId}`);
  }
  const byGate = new Map<GateId, GatePlan>();
  for (const plan of plans) {
    if (byGate.has(plan.gateId)) {
      throw new RcmShadowError('GATE_DOSSIER', 'one plan per gate');
    }
    byGate.set(plan.gateId, plan);
  }
  const missing = GATE_IDS.filter((gateId) => !byGate.has(gateId));
  if (missing.length > 0) {
    throw new RcmShadowError(
      'GATE_DOSSIER',
      `all four gates need a plan; missing ${missing.join(', ')}`,
    );
  }
  const planFor = (gateId: GateId): GatePlan => {
    const plan = byGate.get(gateId);
    if (!plan) {
      throw new RcmShadowError('GATE_DOSSIER', 'unknown gate');
    }
    return plan;
  };
  const forGate = (gateId: GateId, payerId: string | null): readonly GateObservation[] =>
    observations.filter(
      (item) => item.gateId === gateId && (payerId === null || item.payerId === payerId),
    );

  const gates = GATE_IDS.map((gateId) => evaluateGate(planFor(gateId), forGate(gateId, null), now));
  const payerIds = [...new Set(observations.map((item) => item.payerId))].sort();
  const payers = payerIds.map((payerId) => {
    const results = GATE_IDS.map((gateId) =>
      evaluateGate(planFor(gateId), forGate(gateId, payerId), now, `payer=${payerId}`),
    );
    return { payerId, verdict: worst(results.map((result) => result.verdict)), gates: results };
  });
  const content = {
    tenantId,
    computedAt: now,
    computedBy,
    verdict: worst([...gates.map((gate) => gate.verdict), ...payers.map((payer) => payer.verdict)]),
    gates,
    payers,
  };
  const dossier: PromotionDossier = deepFreeze({ ...content, digest: dossierDigest(content) });
  issuedDossiers.add(dossier);
  return dossier;
}

function resolved(value: boolean | null, successWhen: boolean): ObservationOutcome {
  if (value === null) {
    return 'pending';
  }
  return value === successWhen ? 'success' : 'failure';
}

export function fromConcordance(items: readonly ShadowConcordance[]): readonly GateObservation[] {
  return items.map((item) => ({
    observationId: `cc:${item.claimId}`,
    gateId: 'claim-concordance',
    tenantId: item.tenantId,
    payerId: item.payerId,
    seal: item.seal,
    eventAt: item.sealedAt,
    outcome: resolved(item.matchedActual, true),
    critical: false,
    subgroups: item.subgroups,
  }));
}

export function fromDenialOutcomes(
  items: readonly Wp088DenialOutcome[],
): readonly GateObservation[] {
  return items.map((item) => ({
    observationId: `dn:${item.claimId}`,
    gateId: 'denial-free',
    tenantId: item.tenantId,
    payerId: item.payerId,
    seal: item.seal,
    eventAt: item.submittedAt,
    outcome: resolved(item.denied, false),
    critical: false,
    subgroups: item.subgroups,
  }));
}

/** A posting that fails to reconcile moves money wrongly: every such failure is critical. */
export function fromPostingOutcomes(
  items: readonly Wp089PostingOutcome[],
): readonly GateObservation[] {
  return items.map((item) => ({
    observationId: `po:${item.remitId}`,
    gateId: 'posting-reconciliation',
    tenantId: item.tenantId,
    payerId: item.payerId,
    seal: item.seal,
    eventAt: item.receivedAt,
    outcome: resolved(item.reconciled, true),
    critical: item.reconciled === false,
    subgroups: item.subgroups,
  }));
}

export function fromEnrollmentChecks(
  items: readonly Wp091EnrollmentCheck[],
): readonly GateObservation[] {
  return items.map((item) => ({
    observationId: `en:${item.checkId}`,
    gateId: 'enrollment-liveness',
    tenantId: item.tenantId,
    payerId: item.payerId,
    seal: item.seal,
    eventAt: item.checkedAt,
    outcome: item.enrolledAndDiverse ? 'success' : 'failure',
    critical: false,
    subgroups: item.subgroups,
  }));
}
