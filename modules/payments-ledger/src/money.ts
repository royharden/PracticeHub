export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export class MoneyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function assertSafeInteger(value: number, name: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new MoneyError(
      `${name} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`,
    );
  }
}

export function assertMoney(money: Money, name = 'money'): void {
  assertSafeInteger(money.amountMinor, `${name}.amountMinor`);
  if (!/^[A-Z]{3}$/.test(money.currency)) {
    throw new MoneyError(`${name}.currency must be an ISO-4217 uppercase code`);
  }
}

export function safeAdd(left: number, right: number, name = 'money aggregate'): number {
  assertSafeInteger(left, `${name} left`, true);
  assertSafeInteger(right, `${name} right`, true);
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new MoneyError(`${name} overflow`);
  }
  return sum;
}
