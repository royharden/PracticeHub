import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { rehearsalDispositionLedger } from './acceptance-dispositions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('rehearsalDispositionLedger', () => {
  it('encodes only REQ-MIG-018 and REQ-MIG-019', () => {
    expect(rehearsalDispositionLedger.map((row) => row.requirementId)).toEqual([
      'REQ-MIG-018',
      'REQ-MIG-019',
    ]);
  });

  it('keeps encoded evidence files on disk', () => {
    for (const row of rehearsalDispositionLedger) {
      for (const rel of row.evidence) {
        expect(existsSync(join(root, rel)), rel).toBe(true);
      }
    }
  });
});
