import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { voiceDispositionLedger } from './acceptance-dispositions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('voiceDispositionLedger', () => {
  it('covers REQ-VOICE-001 through REQ-VOICE-013', () => {
    const ids = new Set(voiceDispositionLedger.map((row) => row.requirementId));
    for (let n = 1; n <= 13; n += 1) {
      expect(ids.has(`REQ-VOICE-${String(n).padStart(3, '0')}`)).toBe(true);
    }
  });

  it('keeps encoded evidence files on disk', () => {
    for (const row of voiceDispositionLedger) {
      if (row.disposition !== 'ENCODE') continue;
      expect(row.evidence.length).toBeGreaterThan(0);
      for (const rel of row.evidence) {
        expect(existsSync(join(root, rel)), rel).toBe(true);
      }
    }
  });

  it('does not invent encoded AI-agent clauses', () => {
    const encoded = voiceDispositionLedger.filter((row) => row.disposition === 'ENCODE');
    expect(encoded.map((row) => row.requirementId).sort()).toEqual([
      'REQ-VOICE-002',
      'REQ-VOICE-012',
      'REQ-VOICE-013',
    ]);
  });
});
