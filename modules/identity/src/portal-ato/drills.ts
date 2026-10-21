/**
 * Portal ATO drills (WP-099; FWD-AUTH-099-ATO-DRILLS). A drill is data (a synthetic attack, the
 * expected containment and a restoration script); the runner reports one check per invariant, so
 * a drill that stops containing an attack fails by name instead of passing quietly.
 */

import type { PersonId, TenantId } from '@practicehub/contracts';

import { tuneAtoThresholds, type AccountLockdown, type AtoThresholds } from '../ato.js';
import type { AuthSession } from '../authn.js';
import type { EndpointAssociation } from '../endpoints.js';
import { restorePortalAccess, runPortalAtoChain } from './ato-chain.js';
import { createIdProofDrillDouble, type IdProofDrillScenario } from './sim-doubles.js';
import type {
  DrillCheck,
  DrillReport,
  PortalAtoChainInput,
  PortalLoginAttempt,
  RestorationAttempt,
} from './types.js';

export interface AtoDrillRestorationStep {
  readonly personId: PersonId;
  readonly identityProofing: IdProofDrillScenario;
  readonly attempt: RestorationAttempt;
  readonly expect: 'released' | 'still-locked';
  readonly expectOffered: 'retry' | 'supervised-manual' | null;
}

export interface AtoDrillScenario {
  readonly drillId: string;
  readonly chain: PortalAtoChainInput;
  readonly expectLocked: readonly PersonId[];
  readonly expectHighRisk: readonly PersonId[];
  readonly expectFallbackNotice: readonly PersonId[];
  readonly expectFailClosedNotice: readonly PersonId[];
  readonly expectCohort: readonly PersonId[];
  readonly restoration: readonly AtoDrillRestorationStep[];
  readonly synthetic: true;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export function runAtoDrill(scenario: AtoDrillScenario): DrillReport {
  const checks: DrillCheck[] = [];
  const check = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };
  const { chain } = scenario;
  const result = runPortalAtoChain(chain);
  const locked = result.accounts.map((account) => account.personId);
  check('locked-set', sameSet(locked, scenario.expectLocked), `locked=${locked.join(',')}`);

  for (const personId of scenario.expectHighRisk) {
    const account = result.accounts.find((item) => item.personId === personId);
    check(
      `high-risk-requires-reproofing:${personId}`,
      account?.risk === 'high' && account.lockdown.releaseRequirement === 're-identity-proofing',
      `risk=${account?.risk ?? 'none'} release=${account?.lockdown.releaseRequirement ?? 'none'}`,
    );
  }

  for (const account of result.accounts) {
    // A lockdown revokes this person's sessions in the chain's tenant only (H-07 / NR-152).
    const stillActive = result.sessions.filter(
      (session) =>
        session.tenantId === chain.tenantId &&
        session.personId === account.personId &&
        session.status === 'active',
    );
    check(
      `sessions-revoked:${account.personId}`,
      stillActive.length === 0,
      `active-after=${stillActive.length}`,
    );
    check(
      `frozen-and-signals-recorded:${account.personId}`,
      account.lockdown.highRiskActionsFrozen &&
        account.lockdown.status === 'active' &&
        account.lockdown.signals.length > 0 &&
        JSON.stringify(account.lockdown.signals) === JSON.stringify(account.signals),
      `signals=${account.lockdown.signals.map((signal) => signal.kind).join(',')}`,
    );
    const changed = chain.recentlyChangedEndpointIds[account.personId] ?? [];
    if (account.notification.status === 'sent') {
      const directive = account.notification.directive;
      const trusted = chain.associations.some(
        (association) =>
          association.personId === account.personId &&
          association.endpointId === directive.endpointId &&
          association.verification === 'verified' &&
          !changed.includes(association.endpointId),
      );
      check(
        `notified-on-trusted-verified-channel:${account.personId}`,
        trusted,
        `${directive.endpointId} (${directive.channelBasis})`,
      );
    }
  }

  // Every (tenant, person) the chain did not lock keeps its sessions, including a locked person's
  // sessions in another tenant.
  const scopes = [
    ...new Set(chain.sessions.map((session) => `${session.tenantId}\u001f${session.personId}`)),
  ].filter((key) => {
    const [tenantId, personId] = key.split('\u001f');
    return !(tenantId === chain.tenantId && locked.some((id) => id === personId));
  });
  for (const key of scopes) {
    const [tenantId, personId] = key.split('\u001f');
    const inScope = (s: {
      readonly tenantId: string;
      readonly personId: string;
      readonly status: string;
    }): boolean => s.tenantId === tenantId && s.personId === personId && s.status === 'active';
    const before = chain.sessions.filter(inScope);
    const after = result.sessions.filter(inScope);
    check(
      `no-collateral-revocation:${tenantId === chain.tenantId ? '' : `${tenantId ?? ''}/`}${personId ?? ''}`,
      before.length === after.length,
      `${after.length}`,
    );
  }

  for (const personId of scenario.expectFallbackNotice) {
    const notification = result.accounts.find((a) => a.personId === personId)?.notification;
    check(
      `prior-verified-fallback:${personId}`,
      notification?.status === 'sent' &&
        notification.directive.channelBasis === 'prior-verified-fallback' &&
        notification.directive.contactChangeTreatedAsIncident,
      notification?.status ?? 'none',
    );
  }
  for (const personId of scenario.expectFailClosedNotice) {
    const account = result.accounts.find((a) => a.personId === personId);
    check(
      `fail-closed-still-locked:${personId}`,
      account?.notification.status === 'fail-closed' &&
        account.notification.route === 'supervised-manual' &&
        account.lockdown.status === 'active',
      account?.notification.status ?? 'none',
    );
  }

  const cohort = result.cohortProtection;
  check(
    'cohort-protection',
    scenario.expectCohort.length === 0
      ? cohort === null
      : cohort !== null &&
          cohort.rateLimit &&
          cohort.invokedBy === chain.cohortProtectionInvokedBy &&
          sameSet(cohort.forcedCredentialResetPersonIds, scenario.expectCohort),
    cohort === null ? 'none' : cohort.forcedCredentialResetPersonIds.join(','),
  );

  const current = new Map<string, AccountLockdown>(
    result.accounts.map((account) => [account.personId, account.lockdown]),
  );
  scenario.restoration.forEach((step, index) => {
    const name = `restoration:${index + 1}:${step.personId}:${step.attempt.kind}`;
    const lockdown = current.get(step.personId);
    if (lockdown === undefined) {
      check(name, false, 'no lockdown to restore');
      return;
    }
    try {
      const outcome = restorePortalAccess(
        lockdown,
        step.attempt,
        createIdProofDrillDouble(step.identityProofing),
      );
      const offered = outcome.status === 'still-locked' ? outcome.offered : null;
      check(
        name,
        outcome.status === step.expect && offered === step.expectOffered,
        outcome.status === 'still-locked' ? `still-locked: ${outcome.reason}` : 'released',
      );
      if (outcome.status === 'released') current.set(step.personId, outcome.lockdown);
    } catch (error) {
      check(name, false, error instanceof Error ? error.message : 'threw');
    }
  });

  const floorProbe: AtoThresholds = {
    failedLoginSignalThreshold: 21,
    newDeviceSignalThreshold: 11,
    detectionEnabled: true,
  };
  let floorHeld = false;
  try {
    tuneAtoThresholds(
      { failedLoginSignalThreshold: 5, newDeviceSignalThreshold: 3, detectionEnabled: true },
      floorProbe,
      'drill-admin-synthetic',
    );
  } catch {
    floorHeld = true;
  }
  check('detection-cannot-be-disabled', floorHeld, 'relaxing past the floor must throw');

  return {
    drillId: scenario.drillId,
    passed: checks.every((item) => item.passed),
    checks,
    synthetic: true,
  };
}

/* ---------------------------------------------------------------- *
 * Synthetic drill fixtures                                          *
 * ---------------------------------------------------------------- */

const tenant = 'northwind-synthetic' as TenantId;
const person = (id: string): PersonId => `np-drill-${id}` as PersonId;

function session(sessionId: string, personId: PersonId, deviceId: string): AuthSession {
  return {
    sessionId,
    tenantId: tenant,
    personId,
    principal: 'portal',
    deviceId,
    assurance: 'aal1',
    status: 'active',
    createdAt: '2026-03-04T01:00:00Z',
    lastActivityAt: '2026-03-04T01:30:00Z',
    synthetic: true,
  };
}

function verified(personId: PersonId, channel: 'email' | 'sms'): EndpointAssociation {
  const endpointId = `nce-${personId}-${channel}`;
  return {
    tenantId: tenant,
    endpointId,
    personId,
    relationship: 'self',
    verification: 'verified',
    evidenceRef: `synthetic-evidence-${endpointId}`,
    source: 'synthetic-portal-enrollment',
    synthetic: true,
  };
}

function attempt(
  attemptId: string,
  personId: PersonId,
  sourceRef: string,
  locationRef: string,
  deviceId: string,
  outcome: 'failed' | 'succeeded',
  observedAt: string,
): PortalLoginAttempt {
  return {
    attemptId,
    personId,
    sourceRef,
    locationRef,
    deviceId,
    outcome,
    observedAt,
    synthetic: true,
  };
}

const BOTNET = 'asn:64500-synthetic-botnet';
const OFFSHORE = 'region:synthetic-offshore';

const stuffingTargets = ['01', '02', '03', '04', '05', '06'].map(person);

/**
 * Credential-stuffing drill: one source fails against six accounts in three minutes, then logs
 * into two of them. Account 03's email was changed inside the incident (fallback to SMS);
 * account 06 had every channel changed (notice fails closed, lockdown must still hold).
 */
export const CREDENTIAL_STUFFING_DRILL: AtoDrillScenario = {
  drillId: 'drill-portal-credential-stuffing',
  chain: {
    tenantId: tenant,
    lockdownIdPrefix: 'lock-stuffing',
    attempts: [
      ...stuffingTargets.map((personId, index) =>
        attempt(
          `att-s-${index + 1}`,
          personId,
          BOTNET,
          OFFSHORE,
          'nde-attacker-01',
          'failed',
          `2026-03-04T02:0${index % 3}:${index % 2 === 0 ? '00' : '30'}Z`,
        ),
      ),
      attempt(
        'att-s-7',
        person('03'),
        BOTNET,
        OFFSHORE,
        'nde-attacker-01',
        'succeeded',
        '2026-03-04T02:04:00Z',
      ),
      attempt(
        'att-s-8',
        person('06'),
        BOTNET,
        OFFSHORE,
        'nde-attacker-01',
        'succeeded',
        '2026-03-04T02:04:30Z',
      ),
      attempt(
        'att-s-9',
        person('07'),
        'asn:64501-synthetic-home',
        'region:us-nv-synthetic',
        'nde-07-phone',
        'succeeded',
        '2026-03-04T02:05:00Z',
      ),
    ],
    sessions: [
      ...[...stuffingTargets, person('07')].map((personId) =>
        session(`sess-${personId}`, personId, `nde-${personId}-phone`),
      ),
      session('sess-attacker-03', person('03'), 'nde-attacker-01'),
      session('sess-attacker-06', person('06'), 'nde-attacker-01'),
    ],
    associations: [...stuffingTargets, person('07')].flatMap((personId) => [
      verified(personId, 'email'),
      verified(personId, 'sms'),
    ]),
    recentlyChangedEndpointIds: {
      [person('03')]: [`nce-${person('03')}-email`],
      [person('06')]: [`nce-${person('06')}-email`, `nce-${person('06')}-sms`],
    },
    failedLoginSignalThreshold: 5,
    cohortProtectionInvokedBy: 'security-admin-synthetic',
    synthetic: true,
  },
  expectLocked: [person('03'), person('06')],
  expectHighRisk: [person('03'), person('06')],
  expectFallbackNotice: [person('03')],
  expectFailClosedNotice: [person('06')],
  expectCohort: stuffingTargets,
  restoration: [
    {
      personId: person('03'),
      identityProofing: 'pass',
      attempt: { kind: 'step-up', evidenceRef: 'synthetic-stepup-03', releasedBy: 'portal-self' },
      expect: 'still-locked',
      expectOffered: 'retry',
    },
    {
      personId: person('03'),
      identityProofing: 'fail',
      attempt: { kind: 're-identity-proofing', method: 'document', releasedBy: 'portal-self' },
      expect: 'still-locked',
      expectOffered: 'supervised-manual',
    },
    {
      personId: person('03'),
      identityProofing: 'outage',
      attempt: { kind: 're-identity-proofing', method: 'document', releasedBy: 'portal-self' },
      expect: 'still-locked',
      expectOffered: 'supervised-manual',
    },
    {
      personId: person('03'),
      identityProofing: 'pass',
      attempt: { kind: 're-identity-proofing', method: 'document', releasedBy: 'portal-self' },
      expect: 'released',
      expectOffered: null,
    },
    {
      personId: person('06'),
      identityProofing: 'pass',
      attempt: {
        kind: 'supervised-manual',
        verifierId: 'front-desk-verifier-synthetic',
        evidenceRef: 'synthetic-in-person-id-check-06',
      },
      expect: 'released',
      expectOffered: null,
    },
  ],
  synthetic: true,
};

/**
 * Impossible-travel drill: account 11 logs in from two regions three minutes apart (the WP-017
 * heuristic); account 12 logs in twice from home; account 13 fails six times from home, a
 * moderate signal whose restoration is step-up, proving restoration is proportional.
 */
export const IMPOSSIBLE_TRAVEL_DRILL: AtoDrillScenario = {
  drillId: 'drill-portal-impossible-travel',
  chain: {
    tenantId: tenant,
    lockdownIdPrefix: 'lock-travel',
    attempts: [
      attempt(
        'att-t-1',
        person('11'),
        'asn:64510-synthetic-home',
        'region:us-nv-synthetic',
        'nde-11-phone',
        'succeeded',
        '2026-03-04T02:00:00Z',
      ),
      attempt(
        'att-t-2',
        person('11'),
        'asn:64520-synthetic-far',
        'region:eu-west-synthetic',
        'nde-unknown-11',
        'succeeded',
        '2026-03-04T02:03:00Z',
      ),
      attempt(
        'att-t-3',
        person('12'),
        'asn:64511-synthetic-home',
        'region:us-fl-synthetic',
        'nde-12-phone',
        'succeeded',
        '2026-03-04T02:00:00Z',
      ),
      attempt(
        'att-t-4',
        person('12'),
        'asn:64511-synthetic-home',
        'region:us-fl-synthetic',
        'nde-12-phone',
        'succeeded',
        '2026-03-04T03:30:00Z',
      ),
      ...[1, 2, 3, 4, 5, 6].map((n) =>
        attempt(
          `att-t-f${n}`,
          person('13'),
          'asn:64512-synthetic-home',
          'region:us-il-synthetic',
          'nde-13-laptop',
          'failed',
          `2026-03-04T02:1${n}:00Z`,
        ),
      ),
    ],
    sessions: ['11', '12', '13'].map((id) =>
      session(`sess-${person(id)}`, person(id), `nde-${id}-phone`),
    ),
    associations: ['11', '12', '13'].map((id) => verified(person(id), 'email')),
    recentlyChangedEndpointIds: {},
    failedLoginSignalThreshold: 5,
    cohortProtectionInvokedBy: 'security-admin-synthetic',
    synthetic: true,
  },
  expectLocked: [person('11'), person('13')],
  expectHighRisk: [person('11')],
  expectFallbackNotice: [],
  expectFailClosedNotice: [],
  expectCohort: [],
  restoration: [
    {
      personId: person('11'),
      identityProofing: 'pass',
      attempt: { kind: 'step-up', evidenceRef: 'synthetic-stepup-11', releasedBy: 'portal-self' },
      expect: 'still-locked',
      expectOffered: 'retry',
    },
    {
      personId: person('11'),
      identityProofing: 'pass',
      attempt: {
        kind: 're-identity-proofing',
        method: 'knowledge-based',
        releasedBy: 'portal-self',
      },
      expect: 'released',
      expectOffered: null,
    },
    {
      personId: person('13'),
      identityProofing: 'pass',
      attempt: { kind: 'step-up', evidenceRef: 'synthetic-stepup-13', releasedBy: 'portal-self' },
      expect: 'released',
      expectOffered: null,
    },
  ],
  synthetic: true,
};
