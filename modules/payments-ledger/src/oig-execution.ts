export const oigRails = ['insurance', 'membership', 'cash'] as const;
export type OigRail = (typeof oigRails)[number];

export interface ChargeFact {
  readonly chargeId: string;
  readonly patientRef: string;
  readonly serviceRef: string;
  readonly serviceDate: string;
  readonly amountMinor: number;
  readonly rail: OigRail;
}

export interface DoubleBillFinding {
  readonly patientRef: string;
  readonly serviceRef: string;
  readonly serviceDate: string;
  readonly chargeIds: readonly string[];
}

/** Seeded pair that the report must return. A miss is a false negative. */
export const seededDoubleBillFixture: readonly ChargeFact[] = [
  {
    chargeId: 'chg-insurance-awv',
    patientRef: 'patient-casey',
    serviceRef: 'svc-awv',
    serviceDate: '2026-03-01',
    amountMinor: 18000,
    rail: 'insurance',
  },
  {
    chargeId: 'chg-membership-awv',
    patientRef: 'patient-casey',
    serviceRef: 'svc-awv',
    serviceDate: '2026-03-01',
    amountMinor: 0,
    rail: 'membership',
  },
  {
    chargeId: 'chg-cash-lab',
    patientRef: 'patient-jordan',
    serviceRef: 'svc-lab',
    serviceDate: '2026-03-01',
    amountMinor: 4500,
    rail: 'cash',
  },
];

const pairKey = (charge: ChargeFact): string =>
  JSON.stringify([charge.patientRef, charge.serviceRef, charge.serviceDate]);

/** Same patient, service, and date billed on more than one rail. */
export function reportDoubleBills(charges: readonly ChargeFact[]): readonly DoubleBillFinding[] {
  const groups = new Map<string, ChargeFact[]>();
  for (const charge of charges) {
    const key = pairKey(charge);
    const group = groups.get(key) ?? [];
    group.push(charge);
    groups.set(key, group);
  }
  const findings: DoubleBillFinding[] = [];
  for (const group of groups.values()) {
    const rails = new Set(group.map((charge) => charge.rail));
    if (group.length < 2 || rails.size < 2) continue;
    const sample = group[0];
    if (sample === undefined) continue;
    findings.push({
      patientRef: sample.patientRef,
      serviceRef: sample.serviceRef,
      serviceDate: sample.serviceDate,
      chargeIds: group.map((charge) => charge.chargeId).sort(),
    });
  }
  return findings;
}

export interface Takeback {
  readonly takebackId: string;
  readonly amountMinor: number;
  readonly absorb: boolean;
}

export type TakebackRoute = 'hardship' | 'reopen';

/** An absorbed takeback is hardship. It does not reopen a patient balance. */
export function routeTakeback(takeback: Takeback): TakebackRoute {
  return takeback.absorb ? 'hardship' : 'reopen';
}
