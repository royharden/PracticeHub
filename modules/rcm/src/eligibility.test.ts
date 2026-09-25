import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WP040_PACKAGE_ID, WP056_PACKAGE_ID, type Wp040CoverageAnswer } from './contracts.js';
import {
  createEligibilityPort,
  runBookingCheck,
  runDayOfCheck,
  runT48Check,
  type EligibilityAnswer,
  type EligibilityPort,
} from './eligibility.js';
import { parseWp040Fixture, parseWp056Fixture } from './placeholder.js';

const directory = dirname(fileURLToPath(import.meta.url));

function loadCoverage(): readonly Wp040CoverageAnswer[] {
  const raw: unknown = JSON.parse(
    readFileSync(resolve(directory, '../fixtures/wp-040-coverage.json'), 'utf8'),
  );
  return parseWp040Fixture(raw).answers;
}

function coverage(checkpoint: Wp040CoverageAnswer['checkpoint']): Wp040CoverageAnswer {
  const answer = loadCoverage().find((item) => item.checkpoint === checkpoint);
  if (!answer) {
    throw new Error(`missing WP-040 ${checkpoint}`);
  }
  return answer;
}

const yes: EligibilityAnswer = {
  sourceId: 'payer-a',
  receivedAt: '2026-09-25T11:00:00Z',
  covered: true,
};
const no: EligibilityAnswer = {
  sourceId: 'payer-b',
  receivedAt: '2026-09-25T11:30:00Z',
  covered: false,
};

describe('WP-081 eligibility rail', () => {
  it('does not treat contradictory same-day answers as a clean yes', () => {
    const decision = runBookingCheck(createEligibilityPort(), {
      now: '2026-09-25T12:00:00Z',
      answers: [yes, no],
      coverage: coverage('booking'),
    });
    expect(decision.disposition).toBe('contradictory');
    expect(decision.cleanYes).toBe(false);
    expect(decision.consumedPort).toBe('eligibility-port');
    expect(coverage('booking').packageId).toBe(WP040_PACKAGE_ID);
  });

  it('denies a stale check and names the check age', () => {
    const decision = runDayOfCheck(createEligibilityPort(), {
      now: '2026-09-25T12:00:00Z',
      answers: [
        {
          sourceId: 'payer-a',
          receivedAt: '2026-09-23T10:00:00Z',
          covered: true,
        },
      ],
      coverage: coverage('day-of'),
    });
    expect(decision.disposition).toBe('stale-denied');
    expect(decision.cleanYes).toBe(false);
    expect(decision.trace).toContain('check age 50h');
    expect(decision.checkAgeHours).toBe(50);
  });

  it('runs booking, T-48, and day-of through the eligibility port', () => {
    const seen: string[] = [];
    const inner = createEligibilityPort();
    const port: EligibilityPort = {
      name: inner.name,
      check(input) {
        seen.push(input.checkpoint);
        return inner.check(input);
      },
    };
    const fresh = {
      now: '2026-09-25T12:00:00Z',
      answers: [yes],
    };
    expect(runBookingCheck(port, { ...fresh, coverage: coverage('booking') }).cleanYes).toBe(true);
    expect(runT48Check(port, { ...fresh, coverage: coverage('t48') }).checkpoint).toBe('t48');
    expect(runDayOfCheck(port, { ...fresh, coverage: coverage('day-of') }).checkpoint).toBe(
      'day-of',
    );
    expect(seen).toEqual(['booking', 't48', 'day-of']);
    const ledger: unknown = JSON.parse(
      readFileSync(resolve(directory, '../fixtures/wp-056-ledger.json'), 'utf8'),
    );
    expect(parseWp056Fixture(ledger).packageId).toBe(WP056_PACKAGE_ID);
  });
});
