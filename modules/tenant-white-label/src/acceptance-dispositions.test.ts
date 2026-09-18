import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { whiteLabelDispositionLedger } from './acceptance-dispositions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('whiteLabelDispositionLedger', () => {
  it('encodes REQ-WL-001 isolation proof', () => {
    expect(whiteLabelDispositionLedger[0]?.requirementId).toBe('REQ-WL-001');
  });

  it('keeps encoded evidence files on disk', () => {
    for (const row of whiteLabelDispositionLedger) {
      for (const rel of row.evidence) {
        expect(existsSync(join(root, rel)), rel).toBe(true);
      }
    }
  });
});
