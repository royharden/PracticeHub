import { createHash } from 'node:crypto';

export const PPDR_THRESHOLD_MINOR = 40000;

export type FeeScheduleId = 'PFS' | 'CLFS';
export type GfeCoverage = 'covered' | 'non-covered';
export type PartyKind = 'provider' | 'facility';
export type PartyRole = 'convening' | 'co-provider' | 'co-facility';

const token = /^[a-z0-9][a-z0-9-]{0,63}$/;
const gfeRefPattern = /^gfe:[a-z0-9][a-z0-9-]{7,63}$/;
const partyRefPattern = /^party:[a-z0-9][a-z0-9-]{7,63}$/;
const subjectRefPattern = /^subject:[a-z0-9][a-z0-9-]{7,63}$/;
const lineRefPattern = /^line:[a-z0-9][a-z0-9-]{7,63}$/;
const codePattern = /^[0-9A-Z]{5}$/;
const noticePattern = /^[a-z0-9-]{1,64}$/;

export class EstimateError extends Error {
  public constructor(
    public readonly code:
      'ESTIMATE_INVALID' | 'RATE_NOT_FOUND' | 'ATTRIBUTION' | 'NO_SELF_PAY_LINE' | 'VARIANCE_INPUT',
  ) {
    super(code);
    this.name = 'EstimateError';
  }
}

export interface FeeScheduleRate {
  readonly schedule: FeeScheduleId;
  readonly scheduleVersionRef: string;
  readonly code: string;
  readonly unitAmountMinor: number;
}

export interface EstimateLineInput {
  readonly lineRef: string;
  readonly schedule: FeeScheduleId;
  readonly code: string;
  readonly quantity: number;
  readonly coverage: GfeCoverage;
  readonly partyKind: PartyKind;
  readonly partyRef: string;
  readonly partyRole: PartyRole;
}

export interface PricedEstimateLine extends EstimateLineInput {
  readonly unitAmountMinor: number;
  readonly expectedAmountMinor: number;
}

export interface GoodFaithEstimate {
  readonly tenantId: string;
  readonly gfeRef: string;
  readonly subjectRef: string;
  readonly conveningPartyKind: PartyKind;
  readonly conveningPartyRef: string;
  readonly pfsVersionRef: string;
  readonly clfsVersionRef: string;
  readonly lines: readonly PricedEstimateLine[];
  readonly gfeTotalMinor: number;
  readonly claimTotalMinor: number;
  readonly currency: 'USD';
  readonly contentSha256: string;
  readonly synthetic: true;
}

export interface PartyAggregate {
  readonly partyKind: PartyKind;
  readonly partyRef: string;
  readonly selfPayMinor: number;
  readonly claimMinor: number;
}

export interface VarianceDecision {
  readonly gfeTotalMinor: number;
  readonly actualTotalMinor: number;
  readonly deltaMinor: number;
  readonly flagged: boolean;
}

export interface PpdrArtifact {
  readonly gfeRef: string;
  readonly gfeTotalMinor: number;
  readonly actualTotalMinor: number;
  readonly deltaMinor: number;
  readonly notices: readonly string[];
}

export interface GfeRetentionRegistration {
  readonly recordClass: 'gfe-record';
  readonly artifactRef: string;
  readonly contentSha256: string;
  readonly packageId: 'WP-051';
}

const rateKey = (schedule: FeeScheduleId, version: string, code: string): string =>
  JSON.stringify([schedule, version, code]);

const money = (value: number, code: EstimateError['code']): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new EstimateError(code);
  return value;
};

export class FeeScheduleBook {
  readonly #rates = new Map<string, number>();

  public add(rate: FeeScheduleRate): void {
    if (!token.test(rate.scheduleVersionRef) || !codePattern.test(rate.code)) {
      throw new EstimateError('ESTIMATE_INVALID');
    }
    const unitAmountMinor = money(rate.unitAmountMinor, 'ESTIMATE_INVALID');
    const key = rateKey(rate.schedule, rate.scheduleVersionRef, rate.code);
    const prior = this.#rates.get(key);
    if (prior !== undefined && prior !== unitAmountMinor)
      throw new EstimateError('ESTIMATE_INVALID');
    this.#rates.set(key, unitAmountMinor);
  }

  public unitAmount(schedule: FeeScheduleId, version: string, code: string): number {
    const found = this.#rates.get(rateKey(schedule, version, code));
    if (found === undefined) throw new EstimateError('RATE_NOT_FOUND');
    return found;
  }
}

const roleMatches = (kind: PartyKind, role: PartyRole): boolean => {
  if (role === 'convening') return kind === 'provider' || kind === 'facility';
  if (role === 'co-provider') return kind === 'provider';
  return kind === 'facility';
};

const assertLineShape = (line: EstimateLineInput): void => {
  if (
    !lineRefPattern.test(line.lineRef) ||
    !codePattern.test(line.code) ||
    !partyRefPattern.test(line.partyRef) ||
    !roleMatches(line.partyKind, line.partyRole) ||
    !Number.isSafeInteger(line.quantity) ||
    line.quantity <= 0
  ) {
    throw new EstimateError('ESTIMATE_INVALID');
  }
};

const assertAttribution = (
  conveningPartyKind: PartyKind,
  conveningPartyRef: string,
  lines: readonly EstimateLineInput[],
): void => {
  if (!lines.some((line) => line.partyRole === 'convening')) throw new EstimateError('ATTRIBUTION');
  const kinds = new Map<string, PartyKind>();
  for (const line of lines) {
    const prior = kinds.get(line.partyRef);
    if (prior !== undefined && prior !== line.partyKind) throw new EstimateError('ATTRIBUTION');
    kinds.set(line.partyRef, line.partyKind);
    const conveningParty =
      line.partyKind === conveningPartyKind && line.partyRef === conveningPartyRef;
    if (line.partyRole === 'convening' && !conveningParty) throw new EstimateError('ATTRIBUTION');
    if (line.partyRole !== 'convening' && conveningParty) throw new EstimateError('ATTRIBUTION');
  }
};

export const canonicalEstimateJson = (
  estimate: Omit<GoodFaithEstimate, 'contentSha256'>,
): string => {
  const lines = [...estimate.lines]
    .map((line) => ({
      code: line.code,
      coverage: line.coverage,
      expectedAmountMinor: line.expectedAmountMinor,
      lineRef: line.lineRef,
      partyKind: line.partyKind,
      partyRef: line.partyRef,
      partyRole: line.partyRole,
      quantity: line.quantity,
      schedule: line.schedule,
      unitAmountMinor: line.unitAmountMinor,
    }))
    .sort((left, right) => left.lineRef.localeCompare(right.lineRef));
  return `${JSON.stringify({
    claimTotalMinor: estimate.claimTotalMinor,
    clfsVersionRef: estimate.clfsVersionRef,
    conveningPartyKind: estimate.conveningPartyKind,
    conveningPartyRef: estimate.conveningPartyRef,
    currency: estimate.currency,
    gfeRef: estimate.gfeRef,
    gfeTotalMinor: estimate.gfeTotalMinor,
    lines,
    pfsVersionRef: estimate.pfsVersionRef,
    subjectRef: estimate.subjectRef,
    synthetic: estimate.synthetic,
    tenantId: estimate.tenantId,
  })}\n`;
};

export const issueGoodFaithEstimate = (input: {
  readonly book: FeeScheduleBook;
  readonly tenantId: string;
  readonly gfeRef: string;
  readonly subjectRef: string;
  readonly conveningPartyKind: PartyKind;
  readonly conveningPartyRef: string;
  readonly pfsVersionRef: string;
  readonly clfsVersionRef: string;
  readonly lines: readonly EstimateLineInput[];
  readonly synthetic: true;
}): GoodFaithEstimate => {
  if (
    !token.test(input.tenantId) ||
    !gfeRefPattern.test(input.gfeRef) ||
    !subjectRefPattern.test(input.subjectRef) ||
    !partyRefPattern.test(input.conveningPartyRef) ||
    !token.test(input.pfsVersionRef) ||
    !token.test(input.clfsVersionRef) ||
    input.lines.length === 0 ||
    input.synthetic !== true
  ) {
    throw new EstimateError('ESTIMATE_INVALID');
  }
  const refs = input.lines.map((line) => line.lineRef);
  if (new Set(refs).size !== refs.length) throw new EstimateError('ESTIMATE_INVALID');
  for (const line of input.lines) assertLineShape(line);
  assertAttribution(input.conveningPartyKind, input.conveningPartyRef, input.lines);
  const lines = Object.freeze(
    input.lines.map((line) => {
      const version = line.schedule === 'PFS' ? input.pfsVersionRef : input.clfsVersionRef;
      const unitAmountMinor = input.book.unitAmount(line.schedule, version, line.code);
      const expectedAmountMinor = unitAmountMinor * line.quantity;
      if (!Number.isSafeInteger(expectedAmountMinor)) throw new EstimateError('ESTIMATE_INVALID');
      return Object.freeze({ ...line, unitAmountMinor, expectedAmountMinor });
    }),
  );
  const gfeTotalMinor = lines
    .filter((line) => line.coverage === 'non-covered')
    .reduce((sum, line) => sum + line.expectedAmountMinor, 0);
  const claimTotalMinor = lines
    .filter((line) => line.coverage === 'covered')
    .reduce((sum, line) => sum + line.expectedAmountMinor, 0);
  if (!Number.isSafeInteger(gfeTotalMinor) || !Number.isSafeInteger(claimTotalMinor)) {
    throw new EstimateError('ESTIMATE_INVALID');
  }
  if (gfeTotalMinor <= 0) throw new EstimateError('NO_SELF_PAY_LINE');
  const body: Omit<GoodFaithEstimate, 'contentSha256'> = {
    tenantId: input.tenantId,
    gfeRef: input.gfeRef,
    subjectRef: input.subjectRef,
    conveningPartyKind: input.conveningPartyKind,
    conveningPartyRef: input.conveningPartyRef,
    pfsVersionRef: input.pfsVersionRef,
    clfsVersionRef: input.clfsVersionRef,
    lines,
    gfeTotalMinor,
    claimTotalMinor,
    currency: 'USD',
    synthetic: true,
  };
  return Object.freeze({
    ...body,
    contentSha256: createHash('sha256').update(canonicalEstimateJson(body), 'utf8').digest('hex'),
  });
};

export const aggregateByParty = (estimate: GoodFaithEstimate): readonly PartyAggregate[] => {
  const totals = new Map<string, PartyAggregate>();
  for (const line of estimate.lines) {
    const key = JSON.stringify([line.partyKind, line.partyRef]);
    const prior = totals.get(key) ?? {
      partyKind: line.partyKind,
      partyRef: line.partyRef,
      selfPayMinor: 0,
      claimMinor: 0,
    };
    const selfPayMinor =
      prior.selfPayMinor + (line.coverage === 'non-covered' ? line.expectedAmountMinor : 0);
    const claimMinor =
      prior.claimMinor + (line.coverage === 'covered' ? line.expectedAmountMinor : 0);
    totals.set(key, { ...prior, selfPayMinor, claimMinor });
  }
  return Object.freeze(
    [...totals.values()]
      .sort((left, right) => left.partyRef.localeCompare(right.partyRef))
      .map((row) => Object.freeze(row)),
  );
};

export const varianceAgainstGfe = (
  gfeTotalMinor: number,
  actualTotalMinor: number,
): VarianceDecision => {
  money(gfeTotalMinor, 'VARIANCE_INPUT');
  money(actualTotalMinor, 'VARIANCE_INPUT');
  const deltaMinor = actualTotalMinor - gfeTotalMinor;
  return Object.freeze({
    gfeTotalMinor,
    actualTotalMinor,
    deltaMinor,
    flagged: deltaMinor >= PPDR_THRESHOLD_MINOR,
  });
};

export const ppdrArtifact = (
  gfeRef: string,
  decision: VarianceDecision,
  notices: readonly string[],
): PpdrArtifact | null => {
  if (!gfeRefPattern.test(gfeRef) || notices.some((notice) => !noticePattern.test(notice))) {
    throw new EstimateError('ESTIMATE_INVALID');
  }
  if (!decision.flagged) return null;
  return Object.freeze({
    gfeRef,
    gfeTotalMinor: decision.gfeTotalMinor,
    actualTotalMinor: decision.actualTotalMinor,
    deltaMinor: decision.deltaMinor,
    notices: Object.freeze([...notices]),
  });
};

export const gfeRetentionRegistration = (estimate: GoodFaithEstimate): GfeRetentionRegistration =>
  Object.freeze({
    recordClass: 'gfe-record',
    artifactRef: estimate.gfeRef,
    contentSha256: estimate.contentSha256,
    packageId: 'WP-051',
  });
