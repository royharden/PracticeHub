/**
 * Named placeholders for the read-only ports WP-097 consumes. Each carries the
 * id of the package that replaces it. They answer from synthetic tables given
 * by the caller and never write.
 */

import type {
  EncountersReadPort,
  IdentityVerificationPort,
  MembershipReadPort,
  MembershipView,
  OpenClinicalItem,
  VerificationOutcome,
} from './contracts.js';

const key = (...parts: readonly string[]): string => JSON.stringify(parts);

/** Stands for the WP-013 identity proofing answer. */
export function placeholderIdentity(
  outcomes: readonly { tenantId: string; personRef: string; outcome: VerificationOutcome }[],
): IdentityVerificationPort {
  const byPerson = new Map(outcomes.map((row) => [key(row.tenantId, row.personRef), row.outcome]));
  return {
    packageId: 'WP-013',
    verify(tenantId: string, personRef: string): VerificationOutcome {
      return byPerson.get(key(tenantId, personRef)) ?? 'failed';
    },
  };
}

/** Stands for the WP-052 membership API v2 read side (renewal date, term, price, state of record). */
export function placeholderMembership(rows: readonly MembershipView[]): MembershipReadPort {
  const byPerson = new Map(rows.map((row) => [key(row.tenantId, row.personRef), row]));
  return {
    packageId: 'WP-052',
    membershipFor(tenantId: string, personRef: string): MembershipView | null {
      return byPerson.get(key(tenantId, personRef)) ?? null;
    },
  };
}

/** Stands for the encounters (M14) open-work read: meds, results, orders, referrals, visits, messages. */
export function placeholderEncounters(
  rows: readonly { tenantId: string; patientRef: string; items: readonly OpenClinicalItem[] }[],
): EncountersReadPort {
  const byPatient = new Map(rows.map((row) => [key(row.tenantId, row.patientRef), row.items]));
  return {
    packageId: 'M14-encounters',
    openItems(tenantId: string, patientRef: string): readonly OpenClinicalItem[] {
      return byPatient.get(key(tenantId, patientRef)) ?? [];
    },
  };
}
