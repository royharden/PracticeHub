import {
  RcmShadowError,
  WP040_PACKAGE_ID,
  type EligibilityCheckpoint,
  type Wp040CoverageAnswer,
} from './contracts.js';

export const ELIGIBILITY_PORT_NAME = 'eligibility-port' as const;

export const CHECKPOINT_MAX_AGE_HOURS: Readonly<Record<EligibilityCheckpoint, number>> = {
  booking: 24,
  t48: 48,
  'day-of': 12,
};

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface EligibilityAnswer {
  readonly sourceId: string;
  readonly receivedAt: string;
  readonly covered: boolean;
}

export interface EligibilityCheckInput {
  readonly now: string;
  readonly answers: readonly EligibilityAnswer[];
  readonly coverage: Wp040CoverageAnswer;
}

export interface EligibilityPortInput extends EligibilityCheckInput {
  readonly checkpoint: EligibilityCheckpoint;
}

export type EligibilityDisposition = 'eligible' | 'ineligible' | 'contradictory' | 'stale-denied';

export interface EligibilityDecision {
  readonly packageId: 'WP-081';
  readonly checkpoint: EligibilityCheckpoint;
  readonly disposition: EligibilityDisposition;
  readonly cleanYes: boolean;
  readonly trace: string;
  readonly checkAgeHours: number | null;
  readonly consumedPort: typeof ELIGIBILITY_PORT_NAME;
  readonly coverage: Wp040CoverageAnswer;
}

export interface EligibilityPort {
  readonly name: typeof ELIGIBILITY_PORT_NAME;
  check(input: EligibilityPortInput): EligibilityDecision;
}

function parseInstant(value: string, code: string): number {
  if (!INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new RcmShadowError(code, 'timestamp must be YYYY-MM-DDTHH:MM:SSZ');
  }
  return Date.parse(value);
}

function assertCoverage(coverage: Wp040CoverageAnswer, checkpoint: EligibilityCheckpoint): void {
  if (coverage.packageId !== WP040_PACKAGE_ID) {
    throw new RcmShadowError('WP040_COVERAGE', 'coverage answer must stand for WP-040');
  }
  if (!TOKEN.test(coverage.appointmentId) || !TOKEN.test(coverage.tenantId)) {
    throw new RcmShadowError('WP040_COVERAGE', 'WP-040 coverage ids must be tokens');
  }
  if (coverage.checkpoint !== checkpoint) {
    throw new RcmShadowError('WP040_COVERAGE', 'WP-040 coverage checkpoint must match the check');
  }
  parseInstant(coverage.serviceAt, 'WP040_COVERAGE');
}

function utcDay(instant: string): string {
  return instant.slice(0, 10);
}

export function createEligibilityPort(): EligibilityPort {
  return {
    name: ELIGIBILITY_PORT_NAME,
    check(input: EligibilityPortInput): EligibilityDecision {
      assertCoverage(input.coverage, input.checkpoint);
      const nowMs = parseInstant(input.now, 'INVALID_NOW');
      const base = {
        packageId: 'WP-081' as const,
        checkpoint: input.checkpoint,
        consumedPort: ELIGIBILITY_PORT_NAME,
        coverage: input.coverage,
      };
      if (input.answers.length === 0) {
        return {
          ...base,
          disposition: 'stale-denied',
          cleanYes: false,
          trace: 'check age unavailable',
          checkAgeHours: null,
        };
      }
      for (const answer of input.answers) {
        if (!TOKEN.test(answer.sourceId)) {
          throw new RcmShadowError('INVALID_ANSWER', 'eligibility sourceId must be a token');
        }
        parseInstant(answer.receivedAt, 'INVALID_ANSWER');
      }
      const newest = input.answers.reduce((left, right) =>
        left.receivedAt >= right.receivedAt ? left : right,
      );
      const newestMs = parseInstant(newest.receivedAt, 'INVALID_ANSWER');
      if (newestMs > nowMs) {
        throw new RcmShadowError('FUTURE_ANSWER', 'eligibility answer is after the check instant');
      }
      const checkAgeHours = Math.floor((nowMs - newestMs) / 3_600_000);
      const limit = CHECKPOINT_MAX_AGE_HOURS[input.checkpoint];
      if (checkAgeHours > limit) {
        return {
          ...base,
          disposition: 'stale-denied',
          cleanYes: false,
          trace: `check age ${checkAgeHours}h exceeds ${input.checkpoint} limit ${limit}h`,
          checkAgeHours,
        };
      }
      const sameDay = input.answers.filter(
        (answer) => utcDay(answer.receivedAt) === utcDay(newest.receivedAt),
      );
      const sawYes = sameDay.some((answer) => answer.covered);
      const sawNo = sameDay.some((answer) => !answer.covered);
      if (sawYes && sawNo) {
        return {
          ...base,
          disposition: 'contradictory',
          cleanYes: false,
          trace: `contradictory same-day answers; check age ${checkAgeHours}h`,
          checkAgeHours,
        };
      }
      if (sawYes) {
        return {
          ...base,
          disposition: 'eligible',
          cleanYes: true,
          trace: `eligible; check age ${checkAgeHours}h`,
          checkAgeHours,
        };
      }
      return {
        ...base,
        disposition: 'ineligible',
        cleanYes: false,
        trace: `ineligible; check age ${checkAgeHours}h`,
        checkAgeHours,
      };
    },
  };
}

function runCheck(
  port: EligibilityPort,
  checkpoint: EligibilityCheckpoint,
  input: EligibilityCheckInput,
): EligibilityDecision {
  if (port.name !== ELIGIBILITY_PORT_NAME) {
    throw new RcmShadowError(
      'ELIGIBILITY_PORT',
      'checkpoint check must consume the eligibility port',
    );
  }
  return port.check({ ...input, checkpoint });
}

export function runBookingCheck(
  port: EligibilityPort,
  input: EligibilityCheckInput,
): EligibilityDecision {
  return runCheck(port, 'booking', input);
}

export function runT48Check(
  port: EligibilityPort,
  input: EligibilityCheckInput,
): EligibilityDecision {
  return runCheck(port, 't48', input);
}

export function runDayOfCheck(
  port: EligibilityPort,
  input: EligibilityCheckInput,
): EligibilityDecision {
  return runCheck(port, 'day-of', input);
}
