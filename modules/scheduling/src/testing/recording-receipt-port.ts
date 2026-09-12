import type { BookingReceipt } from '../types.js';

export interface ReceiptExpectation {
  tenantId: string;
  effectIdentity: string;
  authorityEpoch: number;
  adapterId: string;
  adapterMode: 'synthetic' | 'real';
  currentSourceVersion: number;
}

export class RecordingReceiptPort {
  readonly accepted: BookingReceipt[] = [];
  readonly quarantined: Array<{ receipt: BookingReceipt; reason: string }> = [];

  ingest(
    receipt: BookingReceipt,
    expected: ReceiptExpectation,
  ): 'accepted' | 'duplicate' | 'quarantined' {
    const mismatch =
      receipt.tenantId !== expected.tenantId ||
      receipt.effectIdentity !== expected.effectIdentity ||
      receipt.authorityEpoch !== expected.authorityEpoch ||
      receipt.adapterId !== expected.adapterId ||
      receipt.adapterMode !== expected.adapterMode;
    if (mismatch || receipt.sourceVersion < expected.currentSourceVersion) {
      this.quarantined.push({
        receipt: structuredClone(receipt),
        reason: mismatch ? 'RECEIPT_BOUNDARY_MISMATCH' : 'SOURCE_VERSION_STALE',
      });
      return 'quarantined';
    }
    if (
      this.accepted.some(
        (candidate) =>
          candidate.receiptId === receipt.receiptId ||
          candidate.effectIdentity === receipt.effectIdentity,
      )
    ) {
      return 'duplicate';
    }
    this.accepted.push(structuredClone(receipt));
    return 'accepted';
  }
}
