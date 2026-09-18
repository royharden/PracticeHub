import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));

describe('WP-061 exclusive-path isolation', () => {
  it('does not import medplum, medplum-local, or clinical-contracts packages', () => {
    const files = [
      'adapter.ts',
      'contracts-double.ts',
      'recording-consent.ts',
      'results-release.ts',
      'index.ts',
    ];
    for (const file of files) {
      const body = readFileSync(resolve(directory, file), 'utf8');
      expect(body.includes('@practicehub/clinical-contracts')).toBe(false);
      expect(body.includes('@practicehub/medplum-local')).toBe(false);
      expect(body.includes('@practicehub/adapter-medplum')).toBe(false);
    }
  });
});
