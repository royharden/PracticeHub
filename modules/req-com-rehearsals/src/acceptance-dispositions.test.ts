import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { leftoverCommIds, rehearsalDispositionLedger } from './acceptance-dispositions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('rehearsalDispositionLedger', () => {
  it('encodes the six leftover REQ-COMM IDs from recon', () => {
    expect(rehearsalDispositionLedger.map((row) => row.requirementId)).toEqual([
      ...leftoverCommIds,
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
