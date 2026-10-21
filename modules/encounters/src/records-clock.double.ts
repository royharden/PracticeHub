/**
 * PLACEHOLDER for the WP-019 obligation-clock engine (docs/contracts/clock-api.md,
 * `records-request-closure`). Encounters takes no workspace dependency here, so
 * this leaf double mirrors the frozen contract shape: strictest (`min`)
 * resolution over provider-fact + patient-fact + floor, `dueBasis: duration`,
 * `escalateAt = dueAt - escalationLeadDays`, and the frozen `ClockStatus`
 * vocabulary. Replace with the WP-019 engine on the integration pass
 * (FWD-CLOCK-063-ACCESS).
 */

export type ClockStatus = 'pending' | 'escalated' | 'overdue' | 'satisfied' | 'cancelled';

export interface RecordsClosurePolicy {
  readonly jurisdiction: string;
  readonly version: number;
  readonly durationDays: number;
  readonly escalationLeadDays: number;
  readonly synthetic: true;
}

/** Federal floor for the right of access: 30 days, escalate 5 days before. */
export const recordsClosureFloor: RecordsClosurePolicy = {
  jurisdiction: 'floor',
  version: 1,
  durationDays: 30,
  escalationLeadDays: 5,
  synthetic: true,
};

export interface ResolvedClosurePolicy {
  readonly durationDays: number;
  readonly escalationLeadDays: number;
  readonly provenance: readonly string[];
}

/** Strictest direction is `min` on the deadline; the floor always contributes. */
export function resolveClosurePolicy(
  policies: readonly RecordsClosurePolicy[],
  jurisdictions: readonly string[],
): ResolvedClosurePolicy {
  const contributing = [
    recordsClosureFloor,
    ...policies.filter((p) => jurisdictions.includes(p.jurisdiction)),
  ];
  return {
    durationDays: Math.min(...contributing.map((p) => p.durationDays)),
    escalationLeadDays: Math.min(...contributing.map((p) => p.escalationLeadDays)),
    provenance: contributing.map((p) => `${p.jurisdiction}/v${p.version}`),
  };
}

const dayMs = 24 * 60 * 60 * 1000;

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * dayMs).toISOString();
}

export function computeClockStatus(
  clock: {
    readonly dueAt: string;
    readonly escalateAt: string;
    readonly terminal: 'satisfied' | 'cancelled' | null;
  },
  asOf: string,
): ClockStatus {
  if (clock.terminal !== null) {
    return clock.terminal;
  }
  const now = Date.parse(asOf);
  if (now >= Date.parse(clock.dueAt)) {
    return 'overdue';
  }
  if (now >= Date.parse(clock.escalateAt)) {
    return 'escalated';
  }
  return 'pending';
}
