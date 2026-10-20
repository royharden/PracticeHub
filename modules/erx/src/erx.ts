/** Medication list owned by WP-062. This module does not rebuild it. */
export interface MedicationListPlaceholder {
  readonly packageId: 'WP-062';
  readonly typeName: 'MedicationList';
  readonly fixtureId: 'wp062-medication-list';
}

export const wp062MedicationListPlaceholder: MedicationListPlaceholder = {
  packageId: 'WP-062',
  typeName: 'MedicationList',
  fixtureId: 'wp062-medication-list',
};

export const fixtureVendorId = 'fixture-vendor';

export interface JurisdictionRule {
  readonly jurisdiction: string;
  readonly transmitLegal: boolean;
}

/** XX is the fixture jurisdiction that must block a transmit. */
export const jurisdictionFixture: readonly JurisdictionRule[] = [
  { jurisdiction: 'FL', transmitLegal: true },
  { jurisdiction: 'XX', transmitLegal: false },
];

/**
 * The platform jurisdiction topic an eRx transmit is resolved under (modules/platform-core
 * `jurisdictionTopics`, ADR-005). `@practicehub/erx` does not depend on platform-core yet, so the
 * port below restates only what a transmit needs: the obligations resolved for the topic.
 */
export const ERX_JURISDICTION_TOPIC = 'erx-epcs-pdmp' as const;

/** The platform obligation that forbids a transmit when the jurisdiction cannot be verified. */
export const JURISDICTION_HARD_BLOCK = 'jurisdiction-unverified-hard-block' as const;

export interface ErxJurisdictionDecision {
  readonly topic: typeof ERX_JURISDICTION_TOPIC;
  readonly jurisdiction: string;
  /** False when no pack covers the jurisdiction; an unresolved jurisdiction never transmits. */
  readonly resolved: boolean;
  readonly obligations: readonly string[];
}

/** Resolves transmit legality. The platform-core resolver binds here (forward obligation). */
export interface ErxJurisdictionPort {
  resolve(jurisdiction: string): ErxJurisdictionDecision;
}

/**
 * Fixture port over `jurisdictionFixture`: a legal row resolves with no blocking obligation, an
 * illegal row (XX) resolves with the hard block, and an unknown jurisdiction does not resolve.
 */
export function fixtureJurisdictionPort(
  rules: readonly JurisdictionRule[] = jurisdictionFixture,
): ErxJurisdictionPort {
  return {
    resolve(jurisdiction: string): ErxJurisdictionDecision {
      const rule = rules.find((item) => item.jurisdiction === jurisdiction);
      if (rule === undefined) {
        return { topic: ERX_JURISDICTION_TOPIC, jurisdiction, resolved: false, obligations: [] };
      }
      return {
        topic: ERX_JURISDICTION_TOPIC,
        jurisdiction,
        resolved: true,
        obligations: rule.transmitLegal ? ['erx-mandate'] : [JURISDICTION_HARD_BLOCK],
      };
    },
  };
}

export type ErxKind = 'new' | 'refill' | 'renewal';

export interface ErxQueueItem {
  readonly tenantId: string;
  readonly itemId: string;
  readonly kind: 'refill' | 'renewal';
  readonly medicationRef: string;
}

export type ErxErrorCode = 'UNKNOWN_VENDOR' | 'IDEMPOTENCY_CONFLICT' | 'INVALID_INPUT';

export class ErxError extends Error {
  public constructor(public readonly code: ErxErrorCode) {
    super(code);
    this.name = 'ErxError';
  }
}

export interface ErxTransmitInput {
  readonly tenantId: string;
  readonly vendorId: string;
  readonly kind: ErxKind;
  readonly jurisdiction: string;
  readonly itemId: string;
  readonly medicationRef: string;
}

export type ErxTransmitResult =
  { readonly completed: true } | { readonly completed: false; readonly blocked: 'jurisdiction' };

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function payloadOf(input: ErxTransmitInput): string {
  return JSON.stringify([input.vendorId, input.kind, input.jurisdiction, input.medicationRef]);
}

/**
 * The eRx vendor embed. Every transmit is idempotent per (tenant, itemId): a repeat with the same
 * payload returns the first result and has no second side effect; a repeat with a different
 * payload is refused. A blocked transmit sends nothing and is not recorded, so it is re-judged on
 * retry.
 */
export class ErxEmbed {
  readonly refillQueue: ErxQueueItem[] = [];
  readonly renewalQueue: ErxQueueItem[] = [];
  private readonly transmitted = new Map<
    string,
    { readonly payload: string; readonly result: ErxTransmitResult }
  >();

  public constructor(
    private readonly jurisdictions: ErxJurisdictionPort = fixtureJurisdictionPort(),
  ) {}

  public transmit(input: ErxTransmitInput): ErxTransmitResult {
    if (
      !TOKEN.test(input.tenantId) ||
      !TOKEN.test(input.itemId) ||
      input.medicationRef.trim() === ''
    ) {
      throw new ErxError('INVALID_INPUT');
    }
    if (input.vendorId !== fixtureVendorId) throw new ErxError('UNKNOWN_VENDOR');
    const key = `${input.tenantId}\u001f${input.itemId}`;
    const prior = this.transmitted.get(key);
    if (prior !== undefined) {
      if (prior.payload !== payloadOf(input)) throw new ErxError('IDEMPOTENCY_CONFLICT');
      return prior.result;
    }
    const decision = this.jurisdictions.resolve(input.jurisdiction);
    if (
      decision.topic !== ERX_JURISDICTION_TOPIC ||
      !decision.resolved ||
      decision.obligations.includes(JURISDICTION_HARD_BLOCK)
    ) {
      return { completed: false, blocked: 'jurisdiction' };
    }
    if (input.kind === 'refill' || input.kind === 'renewal') {
      const item: ErxQueueItem = {
        tenantId: input.tenantId,
        itemId: input.itemId,
        kind: input.kind,
        medicationRef: input.medicationRef,
      };
      (input.kind === 'refill' ? this.refillQueue : this.renewalQueue).push(item);
    }
    const result: ErxTransmitResult = { completed: true };
    this.transmitted.set(key, { payload: payloadOf(input), result });
    return result;
  }
}
