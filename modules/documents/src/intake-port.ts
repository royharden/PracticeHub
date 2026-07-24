/**
 * Inbound-fax intake port (WP-024). Contract: docs/contracts/blob-api.md §Ports.
 * The documents module owns this port; a fax rail (the fax-sim stub locally,
 * a CPaaS/fax adapter in a later capability walk) implements it and hands the
 * module synthetic inbound-fax deliveries. The module then stores the bytes via
 * the blob store and opens a document — the auto-match/triage that decides
 * matched vs unmatched vs quarantined is REQ-DOC-009's engine (WP-049).
 */

export interface InboundFaxDelivery {
  readonly faxId: string;
  readonly senderRef: string;
  readonly pageCount: number;
  /** Synthetic UTF-8 content — a live rail streams bytes; the stub holds a string. */
  readonly bytes: string;
  readonly mediaType: string;
  readonly receivedAt: string;
  readonly synthetic: true;
}

/** A pollable source of inbound-fax deliveries. */
export interface InboundFaxPort {
  poll(): readonly InboundFaxDelivery[];
}
