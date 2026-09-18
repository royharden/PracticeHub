export type RehearsalKind = 'rehearsed' | 'forward-whole';

export type LeftoverReqPlatId = 'REQ-PLAT-025' | 'REQ-PLAT-026' | 'REQ-PLAT-030';

export interface RehearsalRecord {
  readonly reqId: LeftoverReqPlatId;
  readonly kind: RehearsalKind;
  readonly simulated: boolean;
  readonly encodedCanonical: false;
}

export class RehearsalError extends Error {
  public constructor(
    public readonly code: 'UNKNOWN_ID' | 'CANONICAL_CLAIM' | 'DUPLICATE' | 'EMPTY',
  ) {
    super(code);
    this.name = 'RehearsalError';
  }
}

const leftoverIds: readonly LeftoverReqPlatId[] = ['REQ-PLAT-025', 'REQ-PLAT-026', 'REQ-PLAT-030'];

const asLeftover = (reqId: string): LeftoverReqPlatId | undefined =>
  leftoverIds.find((id) => id === reqId);

export class ReqPlatRehearsals {
  readonly #rows = new Map<LeftoverReqPlatId, RehearsalRecord>();

  public rehearse(reqId: string): RehearsalRecord {
    const id = asLeftover(reqId);
    if (id === undefined) throw new RehearsalError('UNKNOWN_ID');
    if (this.#rows.has(id)) throw new RehearsalError('DUPLICATE');
    const row: RehearsalRecord = Object.freeze({
      reqId: id,
      kind: 'rehearsed',
      simulated: true,
      encodedCanonical: false,
    });
    this.#rows.set(id, row);
    return row;
  }

  public refuseCanonicalClaim(encodedCanonical: boolean): void {
    if (encodedCanonical) throw new RehearsalError('CANONICAL_CLAIM');
  }

  public list(): readonly RehearsalRecord[] {
    if (this.#rows.size === 0) throw new RehearsalError('EMPTY');
    return Object.freeze([...this.#rows.values()]);
  }
}
