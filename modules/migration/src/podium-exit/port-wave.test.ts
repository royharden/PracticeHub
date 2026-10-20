import { describe, expect, it } from 'vitest';

import { assessLoa } from './number-inventory.js';
import type { OptOutContinuityResult } from './opt-out-continuity.js';
import {
  evaluatePodiumCancellation,
  evaluatePortAcceptance,
  evaluatePortTransmission,
  evaluateRecalendar,
  materializeSenderGrants,
  planCutover,
  planPortRollback,
  portAcceptanceChecks,
  registerPortWaves,
  submitWavePortOrders,
  type PortWave,
} from './port-wave.js';
import type { PortingRailPort, PortOrderReceipt } from './ports.js';
import { authorizeOutbound, foldSendAuthority } from './send-authority.js';
import {
  baseline,
  evidence,
  grant,
  inventory,
  loa,
  numberA,
  numberB,
  otherTenant,
  profile,
  readyGrants,
  tenant,
  wave,
} from './synthetic.js';
import type { PortCapabilityGrant } from './types.js';

const portWave: PortWave = {
  tenantId: tenant,
  waveRef: wave,
  numberRefs: [numberA, numberB],
  synthetic: true,
};
const assessment = assessLoa(loa, inventory, evidence, [profile(numberA), profile(numberB)]);
const target = { tenantId: tenant, waveRef: wave, numberRef: numberA };

function spyRail(status: PortOrderReceipt['status'] = 'submitted'): PortingRailPort & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    submitPortOrder: (input) => {
      calls.push(input.numberRef);
      return Promise.resolve({
        numberRef: input.numberRef,
        portOrderRef: `port-order:${input.numberRef}`,
        status,
        focAt: null,
        receiptRef: null,
        synthetic: true,
      });
    },
  };
}

const continuityOk: OptOutContinuityResult = {
  shipAllowed: true,
  reasons: [],
  unsuppressedContactRefs: [],
};
const ported: PortOrderReceipt = {
  numberRef: numberA,
  portOrderRef: 'port-order-a',
  status: 'ported',
  focAt: '2026-02-01T12:00:00Z',
  receiptRef: 'port-receipt-a',
  synthetic: true,
};

describe('WP-115 IC-1: port transmission requires consent.operational simulated and one number-scoped sender grant', () => {
  const denied: readonly [string, readonly PortCapabilityGrant[], string][] = [
    ['no operational consent', readyGrants([numberA]).slice(1), 'operational-consent-missing'],
    [
      'operational consent only scaffolded',
      [grant('consent.operational', 'scaffolded'), ...readyGrants([numberA]).slice(1)],
      'operational-consent-below-simulated',
    ],
    [
      'operational consent revoked to read-only',
      [grant('consent.operational', 'read-only'), ...readyGrants([numberA]).slice(1)],
      'operational-consent-below-simulated',
    ],
    [
      'operational consent granted to another tenant only',
      [grant('consent.operational', 'active', {}, otherTenant), ...readyGrants([numberA]).slice(1)],
      'operational-consent-missing',
    ],
    ['no sender grant', [grant('consent.operational', 'simulated')], 'sender-grant-missing'],
    [
      'sender grant scoped to the wave but not the number',
      [
        grant('consent.operational', 'simulated'),
        grant('migration.podium-port', 'active', { wave }),
      ],
      'sender-grant-missing',
    ],
    ['sender grant for the other number', readyGrants([numberB]), 'sender-grant-missing'],
    [
      'two sender grants for the number',
      [
        ...readyGrants([numberA]),
        grant('migration.podium-port', 'pilot', { number: numberA, wave }),
      ],
      'sender-grant-ambiguous',
    ],
    [
      'sender grant only scaffolded',
      [
        grant('consent.operational', 'simulated'),
        grant('migration.podium-port', 'scaffolded', { number: numberA, wave }),
      ],
      'sender-grant-below-simulated',
    ],
  ];

  for (const [name, grants, reason] of denied) {
    it(`denies and never reaches the rail: ${name}`, async () => {
      expect(evaluatePortTransmission(target, grants)).toMatchObject({ allow: false });
      expect(evaluatePortTransmission(target, grants).reasons).toContain(reason);
      const rail = spyRail();
      const outcomes = await submitWavePortOrders(
        rail,
        { ...portWave, numberRefs: [numberA] },
        assessment,
        () => grants,
      );
      expect(rail.calls).toEqual([]);
      expect(outcomes).toMatchObject([{ numberRef: numberA, transmitted: false }]);
    });
  }

  it('transmits exactly once per number when both prerequisites hold', async () => {
    const rail = spyRail();
    const outcomes = await submitWavePortOrders(rail, portWave, assessment, () =>
      readyGrants([numberA, numberB]),
    );
    expect(rail.calls).toEqual([numberA, numberB]);
    expect(outcomes.every((outcome) => outcome.transmitted)).toBe(true);
  });

  it('stops the rest of a wave when operational consent is revoked mid-wave', async () => {
    const rail = spyRail();
    let reads = 0;
    const outcomes = await submitWavePortOrders(rail, portWave, assessment, () => {
      reads += 1;
      return reads === 1
        ? readyGrants([numberA, numberB])
        : [grant('consent.operational', 'read-only'), ...readyGrants([numberA, numberB]).slice(1)];
    });
    expect(rail.calls).toEqual([numberA]);
    expect(outcomes[1]).toMatchObject({
      numberRef: numberB,
      transmitted: false,
      reasons: ['operational-consent-below-simulated'],
    });
  });

  it('materializes one number-scoped sender grant per portable number only', () => {
    const blockedB = assessLoa(loa, inventory, evidence.slice(0, 1), [
      profile(numberA),
      profile(numberB),
    ]);
    expect(materializeSenderGrants(portWave, blockedB)).toEqual([
      {
        tenantId: tenant,
        capabilityId: 'migration.podium-port',
        scope: { number: numberA, wave },
        requestedState: 'simulated',
      },
    ]);
  });

  it('refuses to register a number into two waves', () => {
    expect(() =>
      registerPortWaves([portWave, { ...portWave, waveRef: 'wave-nv-02', numberRefs: [numberB] }]),
    ).toThrow(`number ${numberB} is in waves ${wave} and wave-nv-02`);
  });
});

describe('WP-115 cutover, slip, acceptance and rollback (REQ-MIG-003/-004/-010)', () => {
  const current = foldSendAuthority(tenant, numberA, [baseline(numberA)]);
  const cutoverInput = {
    current,
    receipt: ported,
    continuity: continuityOk,
    profile: profile(numberA),
    consentSourceRef: 'consent:northwind-ledger',
    carrierRoutingRef: 'routing:twilio-sim',
    eventId: `auth:${numberA}:2`,
    effectiveAt: '2026-02-01T12:00:00Z',
  };

  it('keeps the old rail authoritative on FOC-confirmed, missed or rejected ports', () => {
    for (const status of ['submitted', 'foc-confirmed', 'foc-missed', 'rejected'] as const) {
      const plan = planCutover({
        ...cutoverInput,
        receipt: { ...ported, status, receiptRef: null },
      });
      expect(plan).toMatchObject({ commit: false, holder: 'podium' });
    }
    expect(planCutover({ ...cutoverInput, receipt: null })).toMatchObject({
      commit: false,
      reasons: ['port-receipt-missing'],
    });
    // Northwind stays blocked because no authority record moved.
    expect(authorizeOutbound(current, 'northwind', '2026-03-01T00:00:00Z').allow).toBe(false);
  });

  it('commits a cutover record that folds into Northwind-only send authority', () => {
    const plan = planCutover(cutoverInput);
    if (!plan.commit) throw new Error(`expected commit, got ${plan.reasons.join(',')}`);
    const after = foldSendAuthority(tenant, numberA, [baseline(numberA), plan.event]);
    expect(after.proven).toBe(true);
    expect(authorizeOutbound(after, 'northwind', '2026-03-01T00:00:00Z').allow).toBe(true);
    expect(authorizeOutbound(after, 'podium', '2026-03-01T00:00:00Z').allow).toBe(false);
  });

  it('requires every recalendar acknowledgement before a new date is usable', () => {
    expect(evaluateRecalendar(['staff-notice', 'freeze-window'])).toEqual({
      complete: false,
      missing: ['patient-contingency', 'vendor-billing', 'acceptance-tests'],
    });
    expect(
      evaluateRecalendar([
        'staff-notice',
        'freeze-window',
        'patient-contingency',
        'vendor-billing',
        'acceptance-tests',
      ]).complete,
    ).toBe(true);
  });

  it('counts an unobserved acceptance check as a failure, never a pass', () => {
    const results = Object.fromEntries(
      portAcceptanceChecks.map((check) => [check, 'pass' as const]),
    );
    delete results['e911-address'];
    const decision = evaluatePortAcceptance({ numberRef: numberA, results });
    expect(decision).toMatchObject({
      accepted: false,
      materialFailures: ['e911-address'],
      unobserved: ['e911-address'],
    });
    const minor = evaluatePortAcceptance({
      numberRef: numberA,
      results: { ...results, 'e911-address': 'pass', queue: 'fail' },
    });
    expect(minor).toMatchObject({ accepted: true, minorFailures: ['queue'] });
  });

  it('rolls a failed port back to the forwarding fallback with SMS frozen for both systems', () => {
    const plan = planCutover(cutoverInput);
    if (!plan.commit) throw new Error('expected commit');
    const afterCutover = foldSendAuthority(tenant, numberA, [baseline(numberA), plan.event]);
    const results = Object.fromEntries(
      portAcceptanceChecks.map((check) => [check, 'pass' as const]),
    );
    const acceptance = evaluatePortAcceptance({
      numberRef: numberA,
      results: { ...results, 'outbound-sms': 'fail', 'inbound-voice': 'fail' },
    });
    const rollback = planPortRollback({
      current: afterCutover,
      acceptance,
      profile: profile(numberA),
      eventId: `auth:${numberA}:3`,
      effectiveAt: '2026-02-02T09:00:00Z',
    });
    expect(rollback).toMatchObject({
      fallbackRef: `fwd:${numberA}`,
      degradedChannels: ['sms', 'voice'],
      patientNoticeRequired: true,
      blockers: [],
    });
    if (rollback === null) throw new Error('expected a rollback plan');
    const frozen = foldSendAuthority(tenant, numberA, [
      baseline(numberA),
      plan.event,
      rollback.authorityEvent,
    ]);
    expect(frozen.proven).toBe(true);
    expect(frozen.holder).toBe('none');
    expect(authorizeOutbound(frozen, 'northwind', '2026-02-03T00:00:00Z')).toMatchObject({
      allow: false,
      alternatePath: 'approved-alternate-path',
    });
    expect(authorizeOutbound(frozen, 'podium', '2026-02-03T00:00:00Z').allow).toBe(false);
  });

  it('blocks Podium cancellation until every number is evidenced, ported, accepted and signed, with a named owner', () => {
    const accepted = evaluatePortAcceptance({
      numberRef: numberA,
      results: Object.fromEntries(portAcceptanceChecks.map((check) => [check, 'pass' as const])),
    });
    const closedA = {
      numberRef: numberA,
      ownerOfRecordEvidenceRef: 'owner-evidence-a',
      portReceiptRef: 'port-receipt-a',
      acceptance: accepted,
      signedOffBy: 'synthetic-practice-manager',
    };
    const openB = { ...closedA, numberRef: numberB, portReceiptRef: null };
    expect(
      evaluatePodiumCancellation({
        numbers: [closedA, openB],
        exportReadiness: 'ready-to-terminate',
        blockingOwnerRef: null,
      }),
    ).toEqual({
      cancellable: false,
      blockers: [`port-receipt-missing:${numberB}`, 'blocking-owner-missing'],
      ownerRef: null,
    });
    expect(
      evaluatePodiumCancellation({
        numbers: [closedA],
        exportReadiness: 'blocked',
        blockingOwnerRef: 'vendor-mgmt-owner',
      }),
    ).toMatchObject({
      cancellable: false,
      blockers: ['export-completeness-unproven'],
      ownerRef: 'vendor-mgmt-owner',
    });
    expect(
      evaluatePodiumCancellation({
        numbers: [closedA],
        exportReadiness: 'ready-to-terminate',
        blockingOwnerRef: null,
      }),
    ).toEqual({ cancellable: true, blockers: [], ownerRef: null });
  });
});
