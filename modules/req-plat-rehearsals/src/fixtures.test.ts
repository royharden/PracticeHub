import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RehearsalError, ReqPlatRehearsals } from './rehearsal.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${root}modules/req-plat-rehearsals/fixtures/${name}`, 'utf8')) as Record<
    string,
    unknown
  >;

describe('WP-128 four-class fixtures', () => {
  it('HAPPY rehearses the three leftover ids', () => {
    const happy = load('WP-128.HAPPY.json');
    expect(happy.synthetic).toBe(true);
    const pack = new ReqPlatRehearsals();
    for (const id of happy.ids as string[]) pack.rehearse(id);
    expect(pack.list()).toHaveLength(3);
  });

  it('BOUNDARY keeps encodedCanonical false', () => {
    const boundary = load('WP-128.BOUNDARY.json');
    expect(boundary.synthetic).toBe(true);
    new ReqPlatRehearsals().refuseCanonicalClaim(Boolean(boundary.encodedCanonical));
  });

  it('FAILURE refuses FORWARD-WHOLE id 001', () => {
    const failure = load('WP-128.FAILURE.json');
    expect(failure.synthetic).toBe(true);
    expect(() => new ReqPlatRehearsals().rehearse(String(failure.forwardWholeId))).toThrowError(
      new RehearsalError('UNKNOWN_ID'),
    );
  });

  it('RECOVERY names refuse-canonical-claim', () => {
    const recovery = load('WP-128.RECOVERY.json');
    expect(recovery.synthetic).toBe(true);
    expect(recovery.action).toBe('refuse-canonical-encoded-claim');
  });
});
