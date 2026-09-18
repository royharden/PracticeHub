import { describe, expect, it } from 'vitest';

import { RehearsalError, ReqPlatRehearsals } from './rehearsal.js';

describe('REQ-PLAT leftover rehearsals', () => {
  it('rehearses 025/026/030 as simulated and never encoded', () => {
    const pack = new ReqPlatRehearsals();
    pack.rehearse('REQ-PLAT-025');
    pack.rehearse('REQ-PLAT-026');
    pack.rehearse('REQ-PLAT-030');
    expect(pack.list().every((row) => row.simulated && row.encodedCanonical === false)).toBe(true);
  });

  it('refuses a canonical encoded claim and an unknown id', () => {
    const pack = new ReqPlatRehearsals();
    expect(() => pack.refuseCanonicalClaim(true)).toThrowError(
      new RehearsalError('CANONICAL_CLAIM'),
    );
    expect(() => pack.rehearse('REQ-PLAT-001')).toThrowError(new RehearsalError('UNKNOWN_ID'));
  });
});
