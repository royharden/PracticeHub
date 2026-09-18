import type { IsolatedRecord, WhiteLabelProfile } from './types.js';
import { IsolationError } from './types.js';
import type { Wp126WhiteLabelDoubleV1 } from './testing/wp126-whitelabel-double-v1.js';

export class TenantIsolationStore {
  readonly #records: IsolatedRecord[] = [];

  public constructor(private readonly whiteLabel: Wp126WhiteLabelDoubleV1) {}

  public put(record: IsolatedRecord): void {
    if (this.whiteLabel.brandFor(record.tenantId) === undefined) {
      throw new IsolationError('UNKNOWN_TENANT');
    }
    this.#records.push(record);
  }

  public get(tenantId: string, recordId: string): IsolatedRecord {
    const record = this.#records.find((row) => row.recordId === recordId);
    if (record === undefined) throw new IsolationError('NOT_FOUND');
    if (record.tenantId !== tenantId) throw new IsolationError('CROSS_TENANT');
    return record;
  }

  public list(tenantId: string): readonly IsolatedRecord[] {
    return this.#records.filter((row) => row.tenantId === tenantId);
  }

  public brand(tenantId: string): WhiteLabelProfile {
    const profile = this.whiteLabel.brandFor(tenantId);
    if (profile === undefined) throw new IsolationError('UNKNOWN_TENANT');
    return profile;
  }
}
