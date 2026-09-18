export type OpaqueProcessorSku = `sku:${string}`;

export class SkuError extends Error {
  public constructor(public readonly code: 'SKU_GRAMMAR' | 'SKU_HEALTH_REVEALING') {
    super(code);
    this.name = 'SkuError';
  }
}

const skuPattern = /^sku:[a-z0-9][a-z0-9-]{7,63}$/;

const healthTokens = Object.freeze([
  'glp-1',
  'glp1',
  'semaglutide',
  'tirzepatide',
  'diagnosis',
  'prescription',
  'rx',
  'dose',
  'dosage',
  'treatment',
  'condition',
  'symptom',
  'patient',
  'awv',
  'ippe',
]);

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[\s._/\-\\]+/g, '')
    .replace(/0/g, 'o')
    .replace(/1/g, 'l');

export const assertOpaqueProcessorSku = (value: string): OpaqueProcessorSku => {
  if (!skuPattern.test(value)) throw new SkuError('SKU_GRAMMAR');
  const body = value.slice('sku:'.length);
  const compact = normalize(body);
  if (healthTokens.some((token) => compact.includes(normalize(token)))) {
    throw new SkuError('SKU_HEALTH_REVEALING');
  }
  return value as OpaqueProcessorSku;
};
