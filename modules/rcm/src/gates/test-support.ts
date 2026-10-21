import {
  GATE_IDS,
  type GateId,
  type GateObservation,
  type GatePlan,
  type ObservationOutcome,
} from './evaluate.js';

export const REGISTERED_AT = '2026-01-01T00:00:00Z';
export const EVENT_AT = '2026-01-10T00:00:00Z';
export const NOW = '2026-03-01T00:00:00Z';
export const TENANT = 'tenant-synthetic';

export function plan(gateId: GateId, overrides: Partial<GatePlan> = {}): GatePlan {
  return {
    gateId,
    threshold: 0.9,
    confidence: 0.95,
    minSample: 30,
    maturityDays: 30,
    subgroupKeys: ['location'],
    registeredAt: REGISTERED_AT,
    ...overrides,
  };
}

export const ALL_PLANS: readonly GatePlan[] = GATE_IDS.map((gateId) => plan(gateId));

let seq = 0;

/** `count` synthetic sealed observations, the first `successes` of them successful. */
export function observations(
  gateId: GateId,
  payerId: string,
  count: number,
  successes: number,
  subgroups: Readonly<Record<string, string>> = { location: 'loc-nv' },
  overrides: Partial<GateObservation> = {},
): GateObservation[] {
  return Array.from({ length: count }, (_, index) => {
    seq += 1;
    const outcome: ObservationOutcome = index < successes ? 'success' : 'failure';
    return {
      observationId: `obs-${seq}`,
      gateId,
      tenantId: TENANT,
      payerId,
      seal: `seal-${seq}`,
      eventAt: EVENT_AT,
      outcome,
      critical: false,
      subgroups,
      ...overrides,
    };
  });
}

/** A payer whose four gates all pass comfortably. */
export function passingPayer(payerId: string): GateObservation[] {
  return GATE_IDS.flatMap((gateId) => observations(gateId, payerId, 200, 200));
}
