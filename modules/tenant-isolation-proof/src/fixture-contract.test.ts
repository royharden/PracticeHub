import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const classes = ['HAPPY', 'FAILURE', 'RECOVERY', 'BOUNDARY'] as const;

describe('WP-077 isolation fixture contract', () => {
  it('ships four classes for WP-077-ISO probes', () => {
    const names = readdirSync(fixturesDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(names).toEqual(classes.map((cls) => `WP-077-ISO.${cls}.json`).sort());
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
