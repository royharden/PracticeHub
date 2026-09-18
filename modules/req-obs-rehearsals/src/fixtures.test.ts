import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ObsRehearsalError, ReqObsRehearsals } from './rehearsal.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${root}modules/req-obs-rehearsals/fixtures/${name}`, 'utf8')) as Record<
    string,
    unknown
  >;

describe('WP-135 four-class fixtures', () => {
  it('HAPPY rehearses leftover observability ids', () => {
    const happy = load('WP-135.HAPPY.json');
    expect(happy.synthetic).toBe(true);
    const pack = new ReqObsRehearsals();
    for (const id of happy.ids as string[]) pack.rehearse(id);
    expect(pack.list()).toHaveLength(3);
  });

  it('BOUNDARY keeps encodedCanonical false', () => {
    const boundary = load('WP-135.BOUNDARY.json');
    expect(boundary.synthetic).toBe(true);
    new ReqObsRehearsals().refuseCanonicalClaim(Boolean(boundary.encodedCanonical));
  });

  it('FAILURE refuses minting REQ-OBS-*', () => {
    const failure = load('WP-135.FAILURE.json');
    expect(failure.synthetic).toBe(true);
    expect(() => new ReqObsRehearsals().rehearse(String(failure.productMintId))).toThrowError(
      new ObsRehearsalError('PRODUCT_MINT'),
    );
  });

  it('RECOVERY names refuse-product-mint', () => {
    const recovery = load('WP-135.RECOVERY.json');
    expect(recovery.synthetic).toBe(true);
    expect(recovery.action).toBe('refuse-req-obs-product-mint');
  });
});
