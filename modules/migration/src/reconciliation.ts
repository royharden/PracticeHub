import type { ControlTotal, ReconciledControlTotal } from './types.js';

export class ControlTotalError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ControlTotalError';
  }
}

const supportedUnits = new Set(['records', 'currency-minor']);
const approvedRefPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;

function keyOf(total: ControlTotal): string {
  return `${total.name}|${total.unit}|${total.currency ?? ''}`;
}

function assertTotal(total: ControlTotal, expectedSide: ControlTotal['side']): void {
  if (total.synthetic !== true) {
    throw new ControlTotalError(`${total.totalRef} lacks the synthetic watermark`);
  }
  if (!/^[a-z0-9][a-z0-9:._/-]{0,199}$/.test(total.totalRef)) {
    throw new ControlTotalError('control total has an invalid reference');
  }
  if (total.side !== expectedSide) {
    throw new ControlTotalError(`${total.totalRef} is on the wrong side`);
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(total.name)) {
    throw new ControlTotalError(`${total.totalRef} has an invalid name`);
  }
  if (!/^(0|-?[1-9][0-9]*)$/.test(total.valueMinor)) {
    throw new ControlTotalError(`${total.totalRef} valueMinor must be an exact integer string`);
  }
  if (!/^[0-9a-f]{64}$/.test(total.checksum)) {
    throw new ControlTotalError(`${total.totalRef} checksum must be sha-256`);
  }
  if (!supportedUnits.has(total.unit)) {
    throw new ControlTotalError(`${total.totalRef} has an unknown unit`);
  }
  if (total.unit === 'currency-minor' && total.currency === undefined) {
    throw new ControlTotalError(`${total.totalRef} currency total has no currency`);
  }
  if (total.currency !== undefined && !/^[A-Z]{3}$/.test(total.currency)) {
    throw new ControlTotalError(`${total.totalRef} has an invalid currency`);
  }
}

function indexTotals(
  totals: readonly ControlTotal[],
  side: ControlTotal['side'],
): ReadonlyMap<string, ControlTotal> {
  const indexed = new Map<string, ControlTotal>();
  for (const total of totals) {
    assertTotal(total, side);
    const key = keyOf(total);
    if (indexed.has(key)) {
      throw new ControlTotalError(`duplicate ${side} control total ${key}`);
    }
    indexed.set(key, total);
  }
  return indexed;
}

export function reconcileControlTotals(
  tenantId: string,
  source: readonly ControlTotal[],
  target: readonly ControlTotal[],
  approvedExplanations: Readonly<Record<string, string>> = {},
): readonly ReconciledControlTotal[] {
  if (source.length === 0 || target.length === 0) {
    throw new ControlTotalError('required control totals are absent');
  }
  for (const total of [...source, ...target]) {
    if (total.tenantId !== tenantId) {
      throw new ControlTotalError('control-total tenant differs from the workbench tenant');
    }
  }
  const sourceMap = indexTotals(source, 'source');
  const targetMap = indexTotals(target, 'candidate-target');
  const keys = [...new Set([...sourceMap.keys(), ...targetMap.keys()])].sort();
  for (const [key, evidenceRef] of Object.entries(approvedExplanations)) {
    if (!keys.includes(key) || !approvedRefPattern.test(evidenceRef)) {
      throw new ControlTotalError('control-total explanation lacks approved constrained evidence');
    }
  }
  return keys.map((key) => {
    const sourceTotal = sourceMap.get(key);
    const targetTotal = targetMap.get(key);
    if (sourceTotal === undefined || targetTotal === undefined) {
      throw new ControlTotalError(`control total ${key} is present on only one side`);
    }
    const equal =
      sourceTotal.valueMinor === targetTotal.valueMinor &&
      sourceTotal.checksum === targetTotal.checksum;
    const explanationRef = approvedExplanations[key];
    if (equal && explanationRef !== undefined) {
      throw new ControlTotalError('reconciled total carries an unnecessary explanation');
    }
    return {
      name: sourceTotal.name,
      state: equal
        ? 'reconciled'
        : explanationRef === undefined
          ? 'blocking'
          : 'explained-difference',
      source: sourceTotal,
      target: targetTotal,
      ...(explanationRef === undefined ? {} : { explanationRef }),
    };
  });
}
