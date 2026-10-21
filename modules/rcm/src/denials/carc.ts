import { RcmShadowError } from '../contracts.js';

export type DenialQueueId =
  | 'coding-review'
  | 'bundling'
  | 'eligibility-coverage'
  | 'authorization'
  | 'medical-necessity'
  | 'documentation'
  | 'timely-filing'
  | 'duplicate'
  | 'patient-responsibility'
  | 'general-review';

export const DENIAL_QUEUES: readonly DenialQueueId[] = [
  'coding-review',
  'bundling',
  'eligibility-coverage',
  'authorization',
  'medical-necessity',
  'documentation',
  'timely-filing',
  'duplicate',
  'patient-responsibility',
  'general-review',
];

/** X12 claim adjustment group codes. */
export type CarcGroup = 'CO' | 'PR' | 'OA' | 'PI' | 'CR';

export interface CarcAdjustment {
  readonly group: CarcGroup;
  /** Claim Adjustment Reason Code, e.g. "50". */
  readonly code: string;
  readonly amountMinor: number;
}

/** Synthetic routing table: CARC -> queue. Unknown codes route to general-review, never dropped. */
export const CARC_ROUTES: Readonly<Record<string, DenialQueueId>> = {
  '1': 'patient-responsibility',
  '2': 'patient-responsibility',
  '3': 'patient-responsibility',
  '4': 'coding-review',
  '5': 'coding-review',
  '6': 'coding-review',
  '11': 'coding-review',
  '16': 'documentation',
  '18': 'duplicate',
  '26': 'eligibility-coverage',
  '27': 'eligibility-coverage',
  '29': 'timely-filing',
  '31': 'eligibility-coverage',
  '33': 'eligibility-coverage',
  '50': 'medical-necessity',
  '55': 'medical-necessity',
  '56': 'medical-necessity',
  '62': 'authorization',
  '97': 'bundling',
  '109': 'eligibility-coverage',
  '197': 'authorization',
  '198': 'authorization',
  '234': 'bundling',
  '252': 'documentation',
};

/**
 * RARC refinements. They apply only when the deciding CARC is generic (16, or unknown), so a
 * remark can sharpen a vague reason but never overrule a specific one.
 */
export const RARC_REFINEMENTS: Readonly<Record<string, DenialQueueId>> = {
  M127: 'documentation',
  MA130: 'documentation',
  N706: 'documentation',
  N54: 'authorization',
  M51: 'coding-review',
  N130: 'eligibility-coverage',
};

const GENERIC_CARCS: readonly string[] = ['16'];
const CARC_PATTERN = /^[A-Z]?\d{1,3}$/;
const RARC_PATTERN = /^(M|MA|N)\d{1,4}$/;

export interface CarcRouting {
  readonly queue: DenialQueueId;
  /** The CARC that decided the queue: the largest adjustment, first listed on a tie. */
  readonly decidingCarc: string;
  /** The RARC that refined a generic CARC, or null. */
  readonly refinedBy: string | null;
  readonly trace: string;
}

export function routeCarcRarc(
  adjustments: readonly CarcAdjustment[],
  rarcs: readonly string[],
): CarcRouting {
  if (adjustments.length === 0) {
    throw new RcmShadowError('DENIAL_CARC', 'a denial needs at least one CARC adjustment');
  }
  for (const adjustment of adjustments) {
    if (!CARC_PATTERN.test(adjustment.code)) {
      throw new RcmShadowError('DENIAL_CARC', `CARC ${adjustment.code} is not a reason code`);
    }
    if (!Number.isSafeInteger(adjustment.amountMinor) || adjustment.amountMinor < 0) {
      throw new RcmShadowError(
        'DENIAL_CARC',
        'adjustment amount must be a non-negative safe integer',
      );
    }
  }
  for (const rarc of rarcs) {
    if (!RARC_PATTERN.test(rarc)) {
      throw new RcmShadowError('DENIAL_RARC', `RARC ${rarc} is not a remark code`);
    }
  }
  const deciding = adjustments.reduce((left, right) =>
    right.amountMinor > left.amountMinor ? right : left,
  );
  const mapped = CARC_ROUTES[deciding.code];

  if (deciding.group === 'PR' && mapped === 'patient-responsibility') {
    return {
      queue: 'patient-responsibility',
      decidingCarc: deciding.code,
      refinedBy: null,
      trace: `PR-${deciding.code} -> patient-responsibility`,
    };
  }
  const base: DenialQueueId =
    mapped === 'patient-responsibility' ? 'general-review' : (mapped ?? 'general-review');
  if (mapped === undefined || GENERIC_CARCS.includes(deciding.code)) {
    const refinement = rarcs.find((rarc) => RARC_REFINEMENTS[rarc] !== undefined);
    if (refinement !== undefined) {
      const queue = RARC_REFINEMENTS[refinement] ?? base;
      return {
        queue,
        decidingCarc: deciding.code,
        refinedBy: refinement,
        trace: `${deciding.group}-${deciding.code} + ${refinement} -> ${queue}`,
      };
    }
  }
  return {
    queue: base,
    decidingCarc: deciding.code,
    refinedBy: null,
    trace:
      mapped === undefined
        ? `${deciding.group}-${deciding.code} unmapped -> general-review`
        : `${deciding.group}-${deciding.code} -> ${base}`,
  };
}
