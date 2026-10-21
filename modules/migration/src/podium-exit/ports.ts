/**
 * Structural ports for WP-115. `@practicehub/migration` has no runtime edge to
 * comms or consent, so these mirror their shapes the way
 * `adapters/cpaas-twilio` mirrors `CpaasPort`.
 *
 * Placeholders (named, replaced by the package in brackets):
 * - `SuppressionLedgerPort` stands for the cross-system STOP suppression of
 *   @practicehub/consent `canSend` plus comms' unmatched/suppression queue
 *   [WP-044, comms full; REQ-COMM-005/-024].
 * - `PortingRailPort` stands for twilio-sim number-port operations, which the
 *   RAIL-003 simulator does not expose yet (it offers send-message, place-call,
 *   fetch-transcript) [EW-TEL-01/02 external waits; simulated only].
 */

export interface SuppressionLedgerPort {
  /**
   * SMS suppression state for one contact on one business number, as the
   * consent ledger holds it now. `unknown` is never treated as not suppressed.
   */
  smsSuppression(
    tenantId: string,
    contactRef: string,
    numberRef: string,
  ): 'suppressed' | 'not-suppressed' | 'unknown';
}

export type PortOrderStatus =
  'submitted' | 'foc-confirmed' | 'foc-missed' | 'rejected' | 'ported' | 'cancelled';

export interface PortOrderReceipt {
  readonly numberRef: string;
  readonly portOrderRef: string;
  readonly status: PortOrderStatus;
  readonly focAt: string | null;
  readonly receiptRef: string | null;
  readonly synthetic: true;
}

export interface PortingRailPort {
  submitPortOrder(input: {
    readonly tenantId: string;
    readonly numberRef: string;
    readonly loaRef: string;
    readonly idempotencyKey: string;
  }): Promise<PortOrderReceipt>;
}
