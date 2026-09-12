import { assertMoney, type Money } from './money.js';

export type RailOutcome = 'landed' | 'not_landed' | 'unknown';

export interface PaymentRailInput {
  readonly tenantId: string;
  readonly processorAccountRef: string;
  readonly money: Money;
  readonly opaqueProcessorSkuRef?: string;
  readonly originalEffectRef?: string;
  readonly idempotencyKey: string;
  readonly synthetic: boolean;
}

export interface RailEffectObservation {
  readonly effectRef: string;
  readonly outcome: RailOutcome;
  readonly receiptRef?: string;
  readonly observedAt: string;
}

export interface PaymentRailPort {
  createPaymentIntent(input: PaymentRailInput): Promise<RailEffectObservation>;
  refund(input: PaymentRailInput): Promise<RailEffectObservation>;
  reconcileEffect(input: {
    readonly tenantId: string;
    readonly effectRef: string;
    readonly idempotencyKey: string;
    readonly synthetic: boolean;
  }): Promise<RailEffectObservation>;
}

const allowed = new Set([
  'tenantId',
  'processorAccountRef',
  'money',
  'opaqueProcessorSkuRef',
  'originalEffectRef',
  'idempotencyKey',
  'synthetic',
]);

export function validatePaymentRailInput(input: PaymentRailInput): void {
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new MoneyError(`payment rail input contains forbidden fields: ${unexpected.join(', ')}`);
  }
  for (const [name, value] of [
    ['tenantId', input.tenantId],
    ['processorAccountRef', input.processorAccountRef],
    ['idempotencyKey', input.idempotencyKey],
  ] as const) {
    if (value.trim() === '') throw new MoneyError(`${name} is required`);
  }
  assertMoney(input.money);
}

/** Protective lookup only: it cannot call create/refund and stays available after a capability downgrade. */
export async function reconcileUnknownEffect(
  rail: PaymentRailPort,
  input: {
    readonly tenantId: string;
    readonly effectRef: string;
    readonly idempotencyKey: string;
    readonly synthetic: boolean;
  },
): Promise<RailEffectObservation> {
  if (input.effectRef.trim() === '' || input.idempotencyKey.trim() === '') {
    throw new MoneyError('protective reconciliation requires effectRef and idempotencyKey');
  }
  return rail.reconcileEffect(input);
}

class MoneyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PaymentRailInputError';
  }
}
