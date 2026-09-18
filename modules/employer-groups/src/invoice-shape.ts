import type { MultiTinRegistry } from './multi-tin.js';
import type { InvoiceLine, RosterRow } from './types.js';
import { EmployerGroupError } from './types.js';

export function invoiceFromRoster(
  registry: MultiTinRegistry,
  employerRef: string,
  active: readonly RosterRow[],
): readonly InvoiceLine[] {
  const group = registry.require(employerRef);
  const buckets = new Map<string, { tin: RosterRow['tin']; tier: string; headcount: number }>();
  for (const row of active) {
    if (!registry.ownsTin(employerRef, row.tin)) {
      throw new EmployerGroupError('row TIN is not on the employer', 'tin-mismatch');
    }
    const key = `${row.tin}\0${row.tier}`;
    const prior = buckets.get(key);
    if (prior === undefined) {
      buckets.set(key, { tin: row.tin, tier: row.tier, headcount: 1 });
    } else {
      prior.headcount += 1;
    }
  }
  const lines: InvoiceLine[] = [];
  for (const bucket of buckets.values()) {
    const rate = group.rates[bucket.tier];
    if (rate === undefined) {
      throw new EmployerGroupError(`no rate for tier ${bucket.tier}`, 'missing-rate');
    }
    lines.push(
      Object.freeze({
        tin: bucket.tin,
        tier: bucket.tier,
        headcount: bucket.headcount,
        rate,
        amount: bucket.headcount * rate,
        synthetic: true,
      }),
    );
  }
  return lines;
}
