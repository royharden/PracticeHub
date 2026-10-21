import type { RailId } from '../router.js';
import { controlKey } from './store.js';

export type ClaimResponseKind = '999' | '277CA' | '277';

/** An inbound clearinghouse or payer response, matched by control number. */
export interface ClaimResponse {
  readonly responseId: string;
  readonly railId: RailId;
  readonly kind: ClaimResponseKind;
  readonly tenantId: string;
  readonly controlNumber: string;
  /** 999 and 277CA: accepted or rejected. 277: finalized or pending. */
  readonly outcome: 'accepted' | 'rejected' | 'finalized' | 'pending';
}

export interface RailStatus {
  readonly known: boolean;
  readonly responses: readonly ClaimResponse[];
}

/** One 837 as the rail saw it. */
export interface Rail837 {
  readonly tenantId: string;
  readonly claimId: string;
  readonly controlNumber: string;
  readonly totalMinor: number;
}

/** The clearinghouse surface the claim lifecycle calls. */
export interface ClearinghousePort {
  readonly railId: RailId;
  submit837(claim: Rail837): void;
  /** 276/277 claim-status lookup by control number. */
  status(tenantId: string, controlNumber: string): RailStatus;
}

export class RailConnectionDropped extends Error {
  public constructor() {
    super('connection dropped after the rail received the 837');
    this.name = 'RailConnectionDropped';
  }
}

/**
 * Local double for the ch-sim-A and ch-sim-B clearinghouse rails.
 * Synthetic data only; it makes no network call.
 */
export class ClearinghouseSim implements ClearinghousePort {
  private readonly received = new Map<string, number>();
  private readonly responses = new Map<string, ClaimResponse[]>();
  private sequence = 0;
  private dropNextAfterReceipt = false;
  private loseNextSubmission = false;

  public constructor(public readonly railId: RailId) {}

  public submit837(claim: Rail837): void {
    if (this.loseNextSubmission) {
      this.loseNextSubmission = false;
      return;
    }
    const key = controlKey(claim.tenantId, claim.controlNumber);
    this.received.set(key, (this.received.get(key) ?? 0) + 1);
    if (this.dropNextAfterReceipt) {
      this.dropNextAfterReceipt = false;
      throw new RailConnectionDropped();
    }
  }

  public status(tenantId: string, controlNumber: string): RailStatus {
    const key = controlKey(tenantId, controlNumber);
    return {
      known: (this.received.get(key) ?? 0) > 0,
      responses: [...(this.responses.get(key) ?? [])],
    };
  }

  /** How many times this rail received the control number. */
  public receipts(tenantId: string, controlNumber: string): number {
    return this.received.get(controlKey(tenantId, controlNumber)) ?? 0;
  }

  /** Scripts a response the rail holds for status lookups and returns it. */
  public respond(
    tenantId: string,
    controlNumber: string,
    kind: ClaimResponseKind,
    outcome: ClaimResponse['outcome'],
  ): ClaimResponse {
    const key = controlKey(tenantId, controlNumber);
    this.sequence += 1;
    const response: ClaimResponse = {
      responseId: `${this.railId}-${String(this.sequence)}`,
      railId: this.railId,
      kind,
      tenantId,
      controlNumber,
      outcome,
    };
    const list = this.responses.get(key) ?? [];
    list.push(response);
    this.responses.set(key, list);
    return response;
  }

  /** Injection: the next 837 is received, then the connection drops. */
  public dropConnectionAfterNextReceipt(): void {
    this.dropNextAfterReceipt = true;
  }

  /** Injection: the next 837 is acknowledged by transport but never received. */
  public loseNextSubmissionSilently(): void {
    this.loseNextSubmission = true;
  }
}
