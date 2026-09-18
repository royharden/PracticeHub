import type { MembershipVintageDouble, VintageRow } from '../types.js';

export interface AppliedVintage {
  readonly tenantId: string;
  readonly batchRef: string;
  readonly row: VintageRow;
  readonly rolledBack: boolean;
}

/** Local WP-052 membership double. Does not import modules/membership. */
export class Wp052MembershipDoubleV1 implements MembershipVintageDouble {
  readonly #applied: AppliedVintage[] = [];

  public apply(input: {
    readonly tenantId: string;
    readonly batchRef: string;
    readonly row: VintageRow;
  }): void {
    this.#applied.push({ ...input, rolledBack: false });
  }

  public rollback(input: { readonly tenantId: string; readonly batchRef: string }): number {
    let count = 0;
    for (let index = 0; index < this.#applied.length; index += 1) {
      const row = this.#applied[index];
      if (row === undefined) continue;
      if (row.tenantId !== input.tenantId || row.batchRef !== input.batchRef || row.rolledBack) {
        continue;
      }
      this.#applied[index] = { ...row, rolledBack: true };
      count += 1;
    }
    return count;
  }

  public snapshot(): readonly AppliedVintage[] {
    return this.#applied.map((row) => ({ ...row, row: { ...row.row } }));
  }
}
