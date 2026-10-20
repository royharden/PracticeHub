/**
 * WP-099 portal ATO drills (REQ-ID-029; FWD-AUTH-099-ATO-DRILLS): credential stuffing and
 * impossible travel over the WP-014 ato.ts machinery, the verified-channel fallback, and
 * proportional restoration through the identity-proofing port.
 */
import { describe, expect, it } from 'vitest';

import type { PersonId } from '@practicehub/contracts';

import { raiseAtoLockdown, type AccountLockdown } from '../ato.js';
import { AuthnInvariantError } from '../authn.js';
import { detectStuffingWaves, restorePortalAccess, runPortalAtoChain } from './ato-chain.js';
import {
  CREDENTIAL_STUFFING_DRILL,
  IMPOSSIBLE_TRAVEL_DRILL,
  runAtoDrill,
  type AtoDrillScenario,
} from './drills.js';
import { createIdProofDrillDouble } from './sim-doubles.js';

const p = (id: string): PersonId => `np-drill-${id}` as PersonId;

function failedChecks(scenario: AtoDrillScenario): string[] {
  return runAtoDrill(scenario)
    .checks.filter((check) => !check.passed)
    .map((check) => `${check.name}: ${check.detail}`);
}

describe('WP-099 credential-stuffing drill', () => {
  it('passes every check', () => {
    expect(failedChecks(CREDENTIAL_STUFFING_DRILL)).toEqual([]);
    const report = runAtoDrill(CREDENTIAL_STUFFING_DRILL);
    expect(report.passed).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(20);
  });

  it('detects one wave from the botnet source, two compromised accounts and a six-account cohort', () => {
    const waves = detectStuffingWaves(CREDENTIAL_STUFFING_DRILL.chain.attempts);
    expect(waves).toHaveLength(1);
    expect(waves[0]?.sourceRef).toBe('asn:64500-synthetic-botnet');
    expect(waves[0]?.compromisedPersonIds).toEqual([p('03'), p('06')]);
    expect(waves[0]?.targetedPersonIds).toEqual(['01', '02', '03', '04', '05', '06'].map(p));
  });

  it('revokes the attacker sessions and leaves every other account signed in', () => {
    const result = runPortalAtoChain(CREDENTIAL_STUFFING_DRILL.chain);
    const revoked = result.sessions.filter((session) => session.status === 'revoked');
    expect(revoked.map((session) => session.sessionId).sort()).toEqual([
      'sess-attacker-03',
      'sess-attacker-06',
      'sess-np-drill-03',
      'sess-np-drill-06',
    ]);
    expect(revoked.every((session) => session.revokedReason?.startsWith('ato-lockdown:'))).toBe(
      true,
    );
  });

  it('VERIFIED-CHANNEL FALLBACK: a changed email falls back to the prior-verified SMS', () => {
    const result = runPortalAtoChain(CREDENTIAL_STUFFING_DRILL.chain);
    const account = result.accounts.find((item) => item.personId === p('03'));
    expect(account?.notification).toEqual({
      status: 'sent',
      directive: {
        personId: p('03'),
        endpointId: `nce-${p('03')}-sms`,
        channelBasis: 'prior-verified-fallback',
        contactChangeTreatedAsIncident: true,
      },
    });
  });

  it('every channel changed: ato.ts alone would drop the lockdown; the chain still locks', () => {
    const { chain } = CREDENTIAL_STUFFING_DRILL;
    expect(() =>
      raiseAtoLockdown(
        'lock-direct',
        chain.tenantId,
        p('06'),
        [{ kind: 'credential-stuffing', detail: 'synthetic', observedAt: '2026-03-04T02:04:30Z' }],
        chain.sessions,
        chain.associations,
        chain.recentlyChangedEndpointIds[p('06')] ?? [],
        true,
      ),
    ).toThrow(AuthnInvariantError);
    const account = runPortalAtoChain(chain).accounts.find((item) => item.personId === p('06'));
    expect(account?.lockdown.status).toBe('active');
    expect(account?.lockdown.releaseRequirement).toBe('re-identity-proofing');
    expect(account?.notification).toMatchObject({
      status: 'fail-closed',
      route: 'supervised-manual',
    });
  });
});

describe('WP-099 impossible-travel drill', () => {
  it('passes every check', () => {
    expect(failedChecks(IMPOSSIBLE_TRAVEL_DRILL)).toEqual([]);
    expect(runAtoDrill(IMPOSSIBLE_TRAVEL_DRILL).passed).toBe(true);
  });

  it('flags impossible travel through the WP-017 heuristic and restores proportionally', () => {
    const result = runPortalAtoChain(IMPOSSIBLE_TRAVEL_DRILL.chain);
    const traveller = result.accounts.find((item) => item.personId === p('11'));
    expect(traveller?.signals.map((signal) => signal.kind)).toContain('impossible-travel');
    expect(traveller?.lockdown.releaseRequirement).toBe('re-identity-proofing');
    const failures = result.accounts.find((item) => item.personId === p('13'));
    expect(failures?.risk).toBe('moderate');
    expect(failures?.lockdown.releaseRequirement).toBe('step-up');
    expect(result.accounts.some((item) => item.personId === p('12'))).toBe(false);
  });
});

describe('WP-099 the drills can fail', () => {
  it('a drill that expects the wrong containment fails by name', () => {
    const wrong: AtoDrillScenario = {
      ...CREDENTIAL_STUFFING_DRILL,
      expectLocked: [p('03')],
      expectFallbackNotice: [p('06')],
      expectCohort: [p('01')],
    };
    const failed = failedChecks(wrong).map((line) => line.split(':')[0]);
    expect(failed).toEqual(
      expect.arrayContaining(['locked-set', 'prior-verified-fallback', 'cohort-protection']),
    );
    expect(runAtoDrill(wrong).passed).toBe(false);
  });

  it('a restoration expectation that does not hold fails the drill', () => {
    const wrong: AtoDrillScenario = {
      ...IMPOSSIBLE_TRAVEL_DRILL,
      restoration: [
        {
          personId: p('11'),
          identityProofing: 'pass',
          attempt: { kind: 'step-up', evidenceRef: 'synthetic', releasedBy: 'portal-self' },
          expect: 'released',
          expectOffered: null,
        },
      ],
    };
    expect(failedChecks(wrong)).toEqual([
      expect.stringMatching(/^restoration:1:np-drill-11:step-up: still-locked/),
    ]);
  });

  it('a wave below the distinct-account threshold is not a wave', () => {
    expect(
      detectStuffingWaves(CREDENTIAL_STUFFING_DRILL.chain.attempts, {
        distinctAccountsPerSource: 7,
        windowMinutes: 10,
      }),
    ).toEqual([]);
  });
});

describe('WP-099 restoration never silently lifts a lockdown', () => {
  /** Computed inside each test, so a chain failure is reported by test name. */
  function stuffingLockdown(): AccountLockdown {
    const lockdown = runPortalAtoChain(CREDENTIAL_STUFFING_DRILL.chain).accounts[0]?.lockdown;
    if (lockdown === undefined) throw new Error('drill produced no lockdown');
    return lockdown;
  }

  it('an identity-proofing outage keeps the account locked and offers the supervised path', () => {
    const outcome = restorePortalAccess(
      stuffingLockdown(),
      { kind: 're-identity-proofing', method: 'in-person', releasedBy: 'portal-self' },
      createIdProofDrillDouble('outage'),
    );
    expect(outcome).toMatchObject({ status: 'still-locked', offered: 'supervised-manual' });
    expect(outcome.lockdown.status).toBe('active');
  });

  it('a supervised release without evidence is refused', () => {
    const outcome = restorePortalAccess(
      stuffingLockdown(),
      { kind: 'supervised-manual', verifierId: 'front-desk-verifier-synthetic', evidenceRef: '' },
      createIdProofDrillDouble('pass'),
    );
    expect(outcome.status).toBe('still-locked');
  });

  it('a released lockdown cannot be restored again', () => {
    const lockdown = stuffingLockdown();
    const released = restorePortalAccess(
      lockdown,
      { kind: 're-identity-proofing', method: 'document', releasedBy: 'portal-self' },
      createIdProofDrillDouble('pass'),
    );
    if (released.status !== 'released') throw new Error('expected a release');
    expect(released.lockdown.releasedEvidenceRef).toBe(
      `synthetic-idproof:${lockdown.personId}:document`,
    );
    expect(() =>
      restorePortalAccess(
        released.lockdown,
        { kind: 'step-up', evidenceRef: 'x', releasedBy: 'y' },
        createIdProofDrillDouble('pass'),
      ),
    ).toThrow(/not active/);
  });

  it('rejects non-synthetic login attempts', () => {
    const [first] = CREDENTIAL_STUFFING_DRILL.chain.attempts;
    if (first === undefined) throw new Error('no attempts');
    expect(() => detectStuffingWaves([{ ...first, synthetic: false as unknown as true }])).toThrow(
      /not synthetic/,
    );
  });
});
