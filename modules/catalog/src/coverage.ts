export type CoverageClass = 'covered' | 'non-covered' | 'unclassified';

export interface CoverageFlag {
  readonly tenantId: string;
  readonly payerRef: string;
  readonly skuRef: string;
  readonly tableVersionRef: string;
  readonly classification: CoverageClass;
}

export class CoverageError extends Error {
  public constructor(
    public readonly code: 'UNCLASSIFIED' | 'FLAG_NOT_FOUND' | 'PAYER_CONTEXT_MISSING',
  ) {
    super(code);
    this.name = 'CoverageError';
  }
}

const flagKey = (
  tenantId: string,
  payerRef: string,
  skuRef: string,
  tableVersionRef: string,
): string => JSON.stringify([tenantId, payerRef, skuRef, tableVersionRef]);

export class CoverageFlags {
  readonly #flags = new Map<string, CoverageFlag>();

  public add(flag: CoverageFlag): void {
    if (
      flag.tenantId === '' ||
      flag.payerRef === '' ||
      flag.skuRef === '' ||
      flag.tableVersionRef === ''
    ) {
      throw new CoverageError('PAYER_CONTEXT_MISSING');
    }
    this.#flags.set(
      flagKey(flag.tenantId, flag.payerRef, flag.skuRef, flag.tableVersionRef),
      Object.freeze({ ...flag }),
    );
  }

  public resolve(input: {
    readonly tenantId: string;
    readonly payerRef: string;
    readonly skuRef: string;
    readonly tableVersionRef: string;
  }): CoverageFlag {
    if (input.payerRef === '') throw new CoverageError('PAYER_CONTEXT_MISSING');
    const found = this.#flags.get(
      flagKey(input.tenantId, input.payerRef, input.skuRef, input.tableVersionRef),
    );
    if (found === undefined) throw new CoverageError('FLAG_NOT_FOUND');
    if (found.classification === 'unclassified') throw new CoverageError('UNCLASSIFIED');
    return found;
  }
}
