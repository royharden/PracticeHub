import { createHash } from 'node:crypto';

import type { CoverageFlag } from './coverage.js';

export interface SignedCoverageTable {
  readonly tenantId: string;
  readonly tableVersionRef: string;
  readonly signerRef: string;
  readonly flags: readonly CoverageFlag[];
  readonly canonicalSha256: string;
}

export class SignedTableError extends Error {
  public constructor(public readonly code: 'TABLE_DRIFT' | 'ALREADY_SIGNED' | 'TABLE_INVALID') {
    super(code);
    this.name = 'SignedTableError';
  }
}

const canonicalFlag = (flag: CoverageFlag): CoverageFlag => ({
  tenantId: flag.tenantId,
  payerRef: flag.payerRef,
  skuRef: flag.skuRef,
  tableVersionRef: flag.tableVersionRef,
  classification: flag.classification,
});

export const canonicalCoverageTableJson = (input: {
  readonly tenantId: string;
  readonly tableVersionRef: string;
  readonly signerRef: string;
  readonly flags: readonly CoverageFlag[];
}): string => {
  const flags = [...input.flags]
    .map(canonicalFlag)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return `${JSON.stringify({
    flags,
    signerRef: input.signerRef,
    tableVersionRef: input.tableVersionRef,
    tenantId: input.tenantId,
  })}\n`;
};

export const hashCoverageTable = (input: {
  readonly tenantId: string;
  readonly tableVersionRef: string;
  readonly signerRef: string;
  readonly flags: readonly CoverageFlag[];
}): string => createHash('sha256').update(canonicalCoverageTableJson(input), 'utf8').digest('hex');

export class InterimSignedTables {
  readonly #tables = new Map<string, SignedCoverageTable>();

  public sign(input: {
    readonly tenantId: string;
    readonly tableVersionRef: string;
    readonly signerRef: string;
    readonly flags: readonly CoverageFlag[];
  }): SignedCoverageTable {
    if (input.signerRef === '' || input.flags.length === 0)
      throw new SignedTableError('TABLE_INVALID');
    if (
      input.flags.some(
        (flag) =>
          flag.tenantId !== input.tenantId || flag.tableVersionRef !== input.tableVersionRef,
      )
    ) {
      throw new SignedTableError('TABLE_INVALID');
    }
    const key = JSON.stringify([input.tenantId, input.tableVersionRef]);
    if (this.#tables.has(key)) throw new SignedTableError('ALREADY_SIGNED');
    const canonicalSha256 = hashCoverageTable(input);
    const table: SignedCoverageTable = Object.freeze({
      tenantId: input.tenantId,
      tableVersionRef: input.tableVersionRef,
      signerRef: input.signerRef,
      flags: Object.freeze(input.flags.map((flag) => Object.freeze(canonicalFlag(flag)))),
      canonicalSha256,
    });
    this.#tables.set(key, table);
    return table;
  }

  public get(tenantId: string, tableVersionRef: string): SignedCoverageTable {
    const table = this.#tables.get(JSON.stringify([tenantId, tableVersionRef]));
    if (table === undefined) throw new SignedTableError('TABLE_DRIFT');
    const recomputed = hashCoverageTable(table);
    if (recomputed !== table.canonicalSha256) throw new SignedTableError('TABLE_DRIFT');
    return table;
  }
}
