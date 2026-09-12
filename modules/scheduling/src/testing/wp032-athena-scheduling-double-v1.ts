import type {
  ProviderCommitRequest,
  ProviderHoldRequest,
  ProviderProtectiveRequest,
  SchedulingProviderPort,
} from '../ports.js';
import type { BookingReceipt } from '../types.js';

export const WP032_ATHENA_SCHEDULING_DOUBLE_V1 = 'wp032-athena-scheduling-double/v1' as const;

export type SyntheticFailure = 'timeout' | 'ambiguous' | 'conflict';

export class SyntheticProviderError extends Error {
  constructor(
    readonly failure: SyntheticFailure,
    readonly outcomeIndeterminate: boolean,
  ) {
    super(`synthetic-provider-${failure}`);
    this.name = 'SyntheticProviderError';
  }
}

export class AthenaSchedulingDoubleV1 implements SchedulingProviderPort {
  readonly adapterId = WP032_ATHENA_SCHEDULING_DOUBLE_V1;
  readonly adapterMode = 'synthetic' as const;
  readonly attempts: Array<{ operation: string; effectIdentity: string }> = [];
  readonly calls: Array<{ operation: string; effectIdentity: string }> = [];
  private nextFailure: SyntheticFailure | undefined;
  private commitFailure: SyntheticFailure | undefined;
  private cancelFailure: SyntheticFailure | undefined;
  private receiptSequence = 0;

  failNextWith(failure: SyntheticFailure): void {
    this.nextFailure = failure;
  }

  failNextCommitWith(failure: SyntheticFailure): void {
    this.commitFailure = failure;
  }

  failNextCancelWith(failure: SyntheticFailure): void {
    this.cancelFailure = failure;
  }

  async hold(request: ProviderHoldRequest): Promise<BookingReceipt> {
    this.record('hold', request.effectIdentity);
    return this.receipt(
      request.offer.tenantId,
      request.effectIdentity,
      request.authorityEpoch,
      request.offer.sourceVersion,
    );
  }

  async commit(request: ProviderCommitRequest): Promise<BookingReceipt> {
    if (this.commitFailure !== undefined) {
      this.nextFailure = this.commitFailure;
      this.commitFailure = undefined;
    }
    this.record('commit', request.effectIdentity);
    return this.receipt(
      request.tenantId,
      request.effectIdentity,
      request.authorityEpoch,
      request.expectedSourceVersion + 1,
    );
  }

  async release(request: ProviderProtectiveRequest): Promise<BookingReceipt> {
    this.record('release', request.effectIdentity);
    return this.receipt(request.tenantId, request.effectIdentity, request.authorityEpoch, 0);
  }

  async cancel(request: ProviderProtectiveRequest): Promise<BookingReceipt> {
    if (this.cancelFailure !== undefined) {
      this.nextFailure = this.cancelFailure;
      this.cancelFailure = undefined;
    }
    this.record('cancel', request.effectIdentity);
    return this.receipt(request.tenantId, request.effectIdentity, request.authorityEpoch, 0);
  }

  private record(operation: string, effectIdentity: string): void {
    this.attempts.push({ operation, effectIdentity });
    const failure = this.nextFailure;
    this.nextFailure = undefined;
    if (failure !== undefined) {
      throw new SyntheticProviderError(failure, failure !== 'conflict');
    }
    this.calls.push({ operation, effectIdentity });
  }

  private receipt(
    tenantId: string,
    effectIdentity: string,
    authorityEpoch: number,
    sourceVersion: number,
  ): BookingReceipt {
    this.receiptSequence += 1;
    return {
      receiptId: `synthetic-receipt-${this.receiptSequence}`,
      tenantId,
      effectIdentity,
      adapterId: this.adapterId,
      adapterMode: this.adapterMode,
      authorityEpoch,
      sourceVersion,
    };
  }
}

export interface TrustedParityEvidence {
  contractId: string;
  corpusSha256: string;
  independentReviewSha256: string;
  verifiedByCompositionRoot: true;
}

export function requireRealProviderParity(
  port: SchedulingProviderPort,
  evidence?: TrustedParityEvidence,
): void {
  if (
    port.adapterMode !== 'real' ||
    port.adapterId === WP032_ATHENA_SCHEDULING_DOUBLE_V1 ||
    evidence?.verifiedByCompositionRoot !== true ||
    evidence.contractId.trim().length === 0 ||
    !/^[0-9a-f]{64}$/.test(evidence.corpusSha256) ||
    !/^[0-9a-f]{64}$/.test(evidence.independentReviewSha256)
  ) {
    throw new Error('real-wp032-athena-parity-blocked');
  }
}
