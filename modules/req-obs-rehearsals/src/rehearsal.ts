export type LeftoverObsId =
  'leftover-obs-phi-persist' | 'leftover-obs-integration-health' | 'leftover-obs-business';

export interface ObsRehearsalRecord {
  readonly id: LeftoverObsId;
  readonly simulated: boolean;
  readonly encodedCanonical: false;
  readonly productReqObsMinted: false;
}

export class ObsRehearsalError extends Error {
  public constructor(
    public readonly code: 'UNKNOWN_ID' | 'PRODUCT_MINT' | 'CANONICAL_CLAIM' | 'DUPLICATE' | 'EMPTY',
  ) {
    super(code);
    this.name = 'ObsRehearsalError';
  }
}

const leftoverIds: readonly LeftoverObsId[] = [
  'leftover-obs-phi-persist',
  'leftover-obs-integration-health',
  'leftover-obs-business',
];

const asLeftover = (id: string): LeftoverObsId | undefined => leftoverIds.find((row) => row === id);

export class ReqObsRehearsals {
  readonly #rows = new Map<LeftoverObsId, ObsRehearsalRecord>();

  public rehearse(id: string): ObsRehearsalRecord {
    if (id.startsWith('REQ-OBS-')) throw new ObsRehearsalError('PRODUCT_MINT');
    const key = asLeftover(id);
    if (key === undefined) throw new ObsRehearsalError('UNKNOWN_ID');
    if (this.#rows.has(key)) throw new ObsRehearsalError('DUPLICATE');
    const row: ObsRehearsalRecord = Object.freeze({
      id: key,
      simulated: true,
      encodedCanonical: false,
      productReqObsMinted: false,
    });
    this.#rows.set(key, row);
    return row;
  }

  public refuseCanonicalClaim(encodedCanonical: boolean): void {
    if (encodedCanonical) throw new ObsRehearsalError('CANONICAL_CLAIM');
  }

  public list(): readonly ObsRehearsalRecord[] {
    if (this.#rows.size === 0) throw new ObsRehearsalError('EMPTY');
    return Object.freeze([...this.#rows.values()]);
  }
}
