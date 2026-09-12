import { describe, expect, it } from 'vitest';

import { RecordingReceiptPort } from './testing/recording-receipt-port.js';
import {
  AthenaSchedulingDoubleV1,
  requireRealProviderParity,
} from './testing/wp032-athena-scheduling-double-v1.js';

describe('WP-032 replacement boundary', () => {
  it('keeps real Athena parity explicitly blocked for the synthetic double', () => {
    expect(() => requireRealProviderParity(new AthenaSchedulingDoubleV1())).toThrow(
      'real-wp032-athena-parity-blocked',
    );
  });

  it('deduplicates receipts and quarantines stale source versions', () => {
    const port = new RecordingReceiptPort();
    const receipt = {
      receiptId: 'receipt-1',
      tenantId: 'tenant-1',
      effectIdentity: 'tenant|provider|resource|slot|command',
      adapterId: 'wp032-athena-scheduling-double/v1',
      adapterMode: 'synthetic' as const,
      authorityEpoch: 3,
      sourceVersion: 7,
    };
    const expected = {
      tenantId: 'tenant-1',
      effectIdentity: receipt.effectIdentity,
      authorityEpoch: 3,
      adapterId: 'wp032-athena-scheduling-double/v1',
      adapterMode: 'synthetic' as const,
      currentSourceVersion: 7,
    };
    expect(port.ingest(receipt, expected)).toBe('accepted');
    expect(port.ingest(receipt, expected)).toBe('duplicate');
    expect(port.ingest({ ...receipt, receiptId: 'receipt-2', sourceVersion: 6 }, expected)).toBe(
      'quarantined',
    );
    expect(
      port.ingest(
        { ...receipt, receiptId: 'receipt-3', effectIdentity: 'stale-effect', sourceVersion: 6 },
        { ...expected, effectIdentity: 'stale-effect' },
      ),
    ).toBe('quarantined');
    expect(
      port.ingest(
        { ...receipt, receiptId: 'receipt-4', effectIdentity: 'wrong-tenant', tenantId: 'other' },
        { ...expected, effectIdentity: 'wrong-tenant' },
      ),
    ).toBe('quarantined');
  });
});
