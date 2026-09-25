const forbiddenCopy = [
  /\buse your hsa\b/i,
  /\buse your fsa\b/i,
  /\bhsa eligible\b/i,
  /\bfsa eligible\b/i,
];

export class HsaFsaLintError extends Error {
  public constructor(public readonly code: 'REJECTED') {
    super(code);
    this.name = 'HsaFsaLintError';
  }
}

/** Reject catalog copy that steers a covered cost-share onto HSA or FSA. */
export function lintHsaFsaCopy(copy: string): void {
  if (forbiddenCopy.some((pattern) => pattern.test(copy))) {
    throw new HsaFsaLintError('REJECTED');
  }
}
