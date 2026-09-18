import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));

describe('WP-060 AC-17 adapter isolation', () => {
  it('does not import admin apps or the stub adapters/medplum package', () => {
    const files = ['adapter.ts', 'store.ts', 'device.ts', 'index.ts'];
    for (const file of files) {
      const body = readFileSync(resolve(directory, file), 'utf8');
      expect(body.includes('apps/web')).toBe(false);
      expect(body.includes('apps/server')).toBe(false);
      expect(body.includes('@practicehub/adapter-medplum')).toBe(false);
    }
  });
});
