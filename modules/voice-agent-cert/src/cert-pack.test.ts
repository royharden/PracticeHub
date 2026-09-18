import { describe, expect, it } from 'vitest';

import { runCertPack } from './cert-pack.js';
import { CERT_IDENTITY, CertError } from './contracts.js';
import { assertNoSampleDown } from './completeness.js';

describe('WP-103 cert pack', () => {
  it('HAPPY runs all drills without sample-down', () => {
    const result = runCertPack({ sampleDown: false });
    expect(result.identity).toBe(CERT_IDENTITY);
    expect(result.sampledDown).toBe(false);
    expect(result.allPassed).toBe(true);
    expect(result.drills).toHaveLength(5);
    expect(result.drills.every((drill) => drill.passed)).toBe(true);
  });

  it('no-sample-down rule fails incomplete emergency review', () => {
    expect(() => assertNoSampleDown(10, 9)).toThrow(CertError);
  });

  it('sample-down pack is not a pass', () => {
    const result = runCertPack({ sampleDown: true });
    expect(result.sampledDown).toBe(true);
    expect(result.allPassed).toBe(false);
  });
});
