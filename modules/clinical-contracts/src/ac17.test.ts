import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));

describe('WP-060 AC-17 no-admin-app operational dependency', () => {
  it('clinical-contracts sources do not import apps/web or apps/server', () => {
    const files = ['index.ts', 'resources.ts', 'validate.ts', 'wp032-double.ts', 'conformance.ts'];
    for (const file of files) {
      const body = readFileSync(resolve(directory, file), 'utf8');
      expect(body.includes('apps/web')).toBe(false);
      expect(body.includes('apps/server')).toBe(false);
      expect(body.includes('@practicehub/web')).toBe(false);
    }
  });
});
