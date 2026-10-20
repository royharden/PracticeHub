import type { ReviewedCode } from './types.js';

/**
 * The only registry of reviewer-approved codes. `mintReviewedCode` is called from exactly one
 * place, `CodingWorklist.review`, and `revokeReviewedCode` only from the worklist's kill-switch
 * quarantine. Neither is exported from the coding index. Claim ports call `isReviewerMinted` and
 * refuse anything else, including a copy with identical fields or a revoked code.
 */
const minted = new WeakSet<ReviewedCode>();

export function mintReviewedCode(code: ReviewedCode): ReviewedCode {
  const frozen = Object.freeze({ ...code, origin: Object.freeze({ ...code.origin }) });
  minted.add(frozen);
  return frozen;
}

export function revokeReviewedCode(code: ReviewedCode): void {
  minted.delete(code);
}

export function isReviewerMinted(code: ReviewedCode): boolean {
  return minted.has(code);
}
