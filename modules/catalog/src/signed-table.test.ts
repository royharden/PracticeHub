import { describe, expect, it } from 'vitest';

import type { CoverageFlag } from './coverage.js';
import { hashCoverageTable, InterimSignedTables, SignedTableError } from './signed-table.js';

const flags: readonly CoverageFlag[] = [
  {
    tenantId: 'northwind-synthetic',
    payerRef: 'payer-cash',
    skuRef: 'sku:nwind-o1-aaaa',
    tableVersionRef: 'cov-v1',
    classification: 'non-covered',
  },
];

describe('interim signed coverage table', () => {
  it('binds an external SHA-256 and refuses a second sign of the same version', () => {
    const tables = new InterimSignedTables();
    const signed = tables.sign({
      tenantId: 'northwind-synthetic',
      tableVersionRef: 'cov-v1',
      signerRef: 'signer-compliance-1',
      flags,
    });
    expect(signed.canonicalSha256).toBe(
      hashCoverageTable({
        tenantId: signed.tenantId,
        tableVersionRef: signed.tableVersionRef,
        signerRef: signed.signerRef,
        flags: signed.flags,
      }),
    );
    expect(tables.get(signed.tenantId, signed.tableVersionRef)).toBe(signed);
    expect(() =>
      tables.sign({
        tenantId: signed.tenantId,
        tableVersionRef: signed.tableVersionRef,
        signerRef: 'signer-other',
        flags,
      }),
    ).toThrowError(new SignedTableError('ALREADY_SIGNED'));
  });
});
