export type ThreatDisposition = 'in-pack' | 'consumed' | 'forward' | 'residual';

export interface ThreatRow {
  readonly id: string;
  readonly surface: string;
  readonly threat: string;
  readonly mitigation: string;
  readonly disposition: ThreatDisposition;
  readonly ownerWorkPackage: string;
}

export class ThreatModelError extends Error {
  public constructor(public readonly code: 'DUPLICATE_ID' | 'EMPTY_PACK' | 'MISSING_OWNER') {
    super(code);
    this.name = 'ThreatModelError';
  }
}

const WP010_CONSUMED_REF = 'docs/architecture/tenancy-partition-threat-model.md';

export class SecurityPrepThreatModel {
  readonly #rows = new Map<string, ThreatRow>();

  public consumeWp010TenancyModel(): ThreatRow {
    return this.add({
      id: 'EW-SEC-01-T-TENANCY',
      surface: 'tenancy-partition',
      threat: 'Cross-tenant read/write and binding leak (CDX B6)',
      mitigation: `Consumed, not rewritten: ${WP010_CONSUMED_REF}`,
      disposition: 'consumed',
      ownerWorkPackage: 'WP-010',
    });
  }

  public add(row: ThreatRow): ThreatRow {
    if (row.id === '' || row.ownerWorkPackage === '') throw new ThreatModelError('MISSING_OWNER');
    if (this.#rows.has(row.id)) throw new ThreatModelError('DUPLICATE_ID');
    const stored = Object.freeze({ ...row });
    this.#rows.set(stored.id, stored);
    return stored;
  }

  public list(): readonly ThreatRow[] {
    if (this.#rows.size === 0) throw new ThreatModelError('EMPTY_PACK');
    return Object.freeze([...this.#rows.values()]);
  }
}
