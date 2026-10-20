import { RcmShadowError } from '../contracts.js';

import { isReviewerMinted } from './review-mint.js';
import type { CodeSystem, ReviewedCode, ReviewedOrigin } from './types.js';

/**
 * Placeholder for the WP-086 claim lifecycle (claim state machine and claim tables), which is not
 * on disk at this package's base. It stands for the one call WP-087 needs: attach reviewer-approved
 * codes to a claim that is still editable. WP-086 replaces this; its real port must keep the
 * `isReviewerMinted` check.
 */
export const WP086_PACKAGE_ID = 'WP-086' as const;

export type Wp086ClaimState = 'draft' | 'validated' | 'submitted';

export interface Wp086ClaimLine {
  readonly packageId: typeof WP086_PACKAGE_ID;
  readonly claimId: string;
  readonly tenantId: string;
  readonly lineId: string;
  readonly system: CodeSystem;
  readonly code: string;
  readonly units: number;
  readonly serviceDate: string;
  readonly reviewerRef: string;
  readonly reviewedCodeId: string;
  readonly origin: ReviewedOrigin;
}

export interface Wp086ClaimCodingPort {
  readonly packageId: typeof WP086_PACKAGE_ID;
  attachReviewedCode(code: ReviewedCode): Wp086ClaimLine;
  lines(claimId: string): readonly Wp086ClaimLine[];
}

export interface Wp086ClaimSeed {
  readonly claimId: string;
  readonly tenantId: string;
  readonly state: Wp086ClaimState;
}

export function wp086PlaceholderClaimPort(claims: readonly Wp086ClaimSeed[]): Wp086ClaimCodingPort {
  const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
  const lines: Wp086ClaimLine[] = [];
  const attachedIds = new Set<string>();
  return {
    packageId: WP086_PACKAGE_ID,
    attachReviewedCode(code: ReviewedCode): Wp086ClaimLine {
      if (!isReviewerMinted(code)) {
        throw new RcmShadowError(
          'CODING_NOT_REVIEWED',
          'only a code minted by a human reviewer action may reach a claim',
        );
      }
      const claim = byId.get(code.claimId);
      if (claim === undefined || claim.tenantId !== code.tenantId) {
        throw new RcmShadowError('CODING_CLAIM_SCOPE', 'claim is not in the code tenant');
      }
      if (claim.state !== 'draft') {
        throw new RcmShadowError('CODING_CLAIM_LOCKED', 'codes attach only to a draft claim');
      }
      if (attachedIds.has(code.reviewedCodeId)) {
        throw new RcmShadowError('CODING_DUPLICATE', 'reviewed code is already attached');
      }
      attachedIds.add(code.reviewedCodeId);
      const line: Wp086ClaimLine = {
        packageId: WP086_PACKAGE_ID,
        claimId: code.claimId,
        tenantId: code.tenantId,
        lineId: `${code.claimId}:L${String(lines.filter((l) => l.claimId === code.claimId).length + 1)}`,
        system: code.system,
        code: code.code,
        units: code.units,
        serviceDate: code.serviceDate,
        reviewerRef: code.reviewerRef,
        reviewedCodeId: code.reviewedCodeId,
        origin: code.origin,
      };
      lines.push(line);
      return line;
    },
    lines(claimId: string): readonly Wp086ClaimLine[] {
      return lines.filter((line) => line.claimId === claimId);
    },
  };
}
