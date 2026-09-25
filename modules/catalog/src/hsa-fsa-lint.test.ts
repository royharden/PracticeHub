import { describe, expect, it } from 'vitest';

import { HsaFsaLintError, lintHsaFsaCopy } from './hsa-fsa-lint.js';

describe('HSA/FSA copy lint', () => {
  it('rejects copy that fails the lint', () => {
    expect(() => lintHsaFsaCopy('Use your HSA for this covered visit')).toThrowError(
      new HsaFsaLintError('REJECTED'),
    );
    expect(() => lintHsaFsaCopy('This membership is FSA eligible')).toThrowError(
      new HsaFsaLintError('REJECTED'),
    );
  });

  it('accepts copy that does not steer cost-share onto HSA or FSA', () => {
    expect(() => lintHsaFsaCopy('The visit is billed to the plan of record')).not.toThrow();
  });
});
