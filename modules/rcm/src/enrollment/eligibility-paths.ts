import { RcmShadowError } from '../contracts.js';
import type { EligibilityAnswer } from '../eligibility.js';

import type { PathCatalog, PathId } from './paths.js';
import { parseEnrollmentInstant, type EnrollmentRegistry } from './registry.js';

/** The named third eligibility path (Availity-class). Simulated only while EW-CH-01 is open. */
export const THIRD_ELIGIBILITY_PATH_ID = 'availity-sim' as const satisfies PathId;

export interface EligibilityQuery {
  readonly payerId: string;
  readonly memberRef: string;
  readonly requestedAt: string;
}

export type SimulatedEligibilityResponse =
  | { readonly kind: 'answer'; readonly covered: boolean; readonly respondedAt: string }
  | { readonly kind: 'outage' };

export type SimulatedEligibilityResponder = (
  query: EligibilityQuery,
) => SimulatedEligibilityResponse;

export interface EligibilityPath {
  readonly pathId: PathId;
  query(query: EligibilityQuery): SimulatedEligibilityResponse;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function createSimulatedEligibilityPath(
  pathId: PathId,
  catalog: PathCatalog,
  responder: SimulatedEligibilityResponder,
): EligibilityPath {
  if (!catalog.supports(pathId, '270/271')) {
    throw new RcmShadowError('ELIGIBILITY_PATH', 'path does not carry 270/271');
  }
  return { pathId, query: (query) => responder(query) };
}

/** Deterministic synthetic responder: members listed as covered answer yes, others no. */
export function tableResponder(
  coveredMembers: readonly string[],
  latencySeconds = 1,
): SimulatedEligibilityResponder {
  const covered = new Set(coveredMembers);
  return (query) => ({
    kind: 'answer',
    covered: covered.has(query.memberRef),
    respondedAt: new Date(Date.parse(query.requestedAt) + latencySeconds * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z'),
  });
}

export interface SkippedPath {
  readonly pathId: PathId;
  readonly reason: 'not-enrolled' | 'outage';
}

export interface CollectedEligibility {
  /** Shaped for the WP-081 eligibility port: sourceId is the path id. */
  readonly answers: readonly EligibilityAnswer[];
  readonly skipped: readonly SkippedPath[];
}

/**
 * Asks every eligibility path the payer is enrolled on for 270/271, in the order given.
 * A path without an enrolled 270/271 is skipped, never queried, so an unenrolled path can
 * never appear as a redundant answer.
 */
export function collectEligibilityAnswers(
  registry: EnrollmentRegistry,
  paths: readonly EligibilityPath[],
  query: EligibilityQuery,
): CollectedEligibility {
  if (!TOKEN.test(query.payerId) || !TOKEN.test(query.memberRef)) {
    throw new RcmShadowError('ELIGIBILITY_QUERY', 'payerId and memberRef must be tokens');
  }
  const requestedMs = parseEnrollmentInstant(query.requestedAt, 'ELIGIBILITY_QUERY');
  const seen = new Set<PathId>();
  const answers: EligibilityAnswer[] = [];
  const skipped: SkippedPath[] = [];
  for (const path of paths) {
    if (seen.has(path.pathId)) {
      throw new RcmShadowError('ELIGIBILITY_PATH', 'each path is asked once');
    }
    seen.add(path.pathId);
    if (
      !registry.isEnrolled({ payerId: query.payerId, pathId: path.pathId, transaction: '270/271' })
    ) {
      skipped.push({ pathId: path.pathId, reason: 'not-enrolled' });
      continue;
    }
    const response = path.query(query);
    if (response.kind === 'outage') {
      skipped.push({ pathId: path.pathId, reason: 'outage' });
      continue;
    }
    if (parseEnrollmentInstant(response.respondedAt, 'ELIGIBILITY_RESPONSE') < requestedMs) {
      throw new RcmShadowError('ELIGIBILITY_RESPONSE', 'a response cannot precede its request');
    }
    answers.push({
      sourceId: path.pathId,
      receivedAt: response.respondedAt,
      covered: response.covered,
    });
  }
  return { answers, skipped };
}
