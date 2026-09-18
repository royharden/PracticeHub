import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const classes = ['HAPPY', 'FAILURE', 'RECOVERY', 'BOUNDARY'] as const;
const reqs = ['REQ-SCH-002', 'REQ-SCH-003', 'REQ-SCH-021', 'REQ-SCH-022'];

describe('WP-134 fixture contract', () => {
  it('ships four classes for the encoded leftover REQ-SCH probes only', () => {
    const names = readdirSync(fixturesDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(names).toEqual(reqs.flatMap((req) => classes.map((cls) => `${req}.${cls}.json`)).sort());
    for (const name of names) {
      const body = JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as {
        requirement: string;
        class: string;
        synthetic: boolean;
      };
      expect(body.synthetic).toBe(true);
      expect(name.startsWith(`${body.requirement}.`)).toBe(true);
    }
  });
});
