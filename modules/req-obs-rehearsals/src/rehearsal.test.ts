import { describe, expect, it } from 'vitest';

import { ObsRehearsalError, ReqObsRehearsals } from './rehearsal.js';

describe('leftover observability rehearsals', () => {
  it('rehearses three leftover ids without minting REQ-OBS product rows', () => {
    const pack = new ReqObsRehearsals();
    pack.rehearse('leftover-obs-phi-persist');
    pack.rehearse('leftover-obs-integration-health');
    pack.rehearse('leftover-obs-business');
    expect(
      pack
        .list()
        .every((row) => row.encodedCanonical === false && row.productReqObsMinted === false),
    ).toBe(true);
  });

  it('refuses REQ-OBS-* product mint and canonical encoded claims', () => {
    const pack = new ReqObsRehearsals();
    expect(() => pack.rehearse('REQ-OBS-001')).toThrowError(new ObsRehearsalError('PRODUCT_MINT'));
    expect(() => pack.refuseCanonicalClaim(true)).toThrowError(
      new ObsRehearsalError('CANONICAL_CLAIM'),
    );
  });
});
