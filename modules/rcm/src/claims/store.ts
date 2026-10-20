import { RcmShadowError } from '../contracts.js';
import type { ClaimLine, ProducedEdit } from '../edit-library.js';
import type { RailId } from '../router.js';
import type { ClaimResponse } from './ch-sim.js';
import type { ClaimState } from './state-machine.js';

export interface ClaimTransition {
  readonly from: ClaimState | null;
  readonly to: ClaimState;
  readonly at: number;
  readonly reason: string;
}

export interface ClaimException {
  readonly reason: string;
  readonly owner: string;
  /** Set when a person resolved the exception; the responses parked against it are closed. */
  readonly resolution?: ExceptionResolution;
}

export interface ExceptionResolution {
  readonly by: string;
  readonly at: number;
  readonly reason: string;
  readonly closedResponseIds: readonly string[];
}

export interface ClaimRecord {
  readonly claimId: string;
  readonly tenantId: string;
  readonly payerId: string;
  readonly controlNumber: string;
  readonly totalMinor: number;
  readonly lines: readonly ClaimLine[];
  readonly edits: readonly ProducedEdit[];
  readonly state: ClaimState;
  readonly railId: RailId | null;
  readonly resubmissions: number;
  readonly stateChangedAt: number;
  readonly version: number;
  readonly exception: ClaimException | null;
  readonly history: readonly ClaimTransition[];
}

/**
 * Durable claim persistence. The lifecycle engine keeps no claim state of
 * its own, so a new engine over the same store is a process restart.
 */
export interface ClaimStore {
  insert(record: ClaimRecord): void;
  /** Compare-and-set: `record.version` must be the stored version plus one. */
  put(record: ClaimRecord): void;
  get(claimId: string): ClaimRecord | undefined;
  byControlNumber(tenantId: string, controlNumber: string): ClaimRecord | undefined;
  list(): readonly ClaimRecord[];
  /** True once a response id has been handled (applied, superseded, conflicted or orphaned). */
  hasHandledResponse(responseId: string): boolean;
  /** Records a response id as handled. Only called after the response is dealt with. */
  markResponseHandled(responseId: string): void;
  recordOrphanResponse(response: ClaimResponse): void;
  orphanResponses(): readonly ClaimResponse[];
  /** Holds a response that arrived before its claim could take it; idempotent by response id. */
  parkResponse(response: ClaimResponse): void;
  unparkResponse(responseId: string): void;
  parkedResponses(tenantId: string, controlNumber: string): readonly ClaimResponse[];
  recordConflict(conflict: ResponseConflict): void;
  conflicts(): readonly ResponseConflict[];
}

/** A response that contradicts what the claim already recorded; owned, never dropped. */
export interface ResponseConflict {
  readonly response: ClaimResponse;
  readonly claimId: string;
  readonly stateAtArrival: ClaimState;
  readonly owner: string;
}

export function controlKey(tenantId: string, controlNumber: string): string {
  return `${tenantId}\u001f${controlNumber}`;
}

/**
 * Stands for the WP-086 claim tables until a database adapter replaces it.
 * Records are copied in and out so no caller can mutate persisted state.
 */
export class InMemoryClaimStore implements ClaimStore {
  private readonly claims = new Map<string, ClaimRecord>();
  private readonly controls = new Map<string, string>();
  private readonly responseIds = new Set<string>();
  private readonly orphans: ClaimResponse[] = [];
  private readonly parked = new Map<string, ClaimResponse>();
  private readonly conflictLog: ResponseConflict[] = [];

  public insert(record: ClaimRecord): void {
    if (this.claims.has(record.claimId)) {
      throw new RcmShadowError('CLAIM_DUPLICATE_ID', 'claimId is already registered');
    }
    const key = controlKey(record.tenantId, record.controlNumber);
    if (this.controls.has(key)) {
      throw new RcmShadowError('CLAIM_DUPLICATE_CONTROL', 'control number is already used');
    }
    if (record.version !== 1) {
      throw new RcmShadowError('CLAIM_VERSION', 'a new claim starts at version 1');
    }
    this.claims.set(record.claimId, structuredClone(record));
    this.controls.set(key, record.claimId);
  }

  public put(record: ClaimRecord): void {
    const stored = this.claims.get(record.claimId);
    if (!stored) {
      throw new RcmShadowError('CLAIM_UNKNOWN', 'claim is not registered');
    }
    if (
      record.version !== stored.version + 1 ||
      record.controlNumber !== stored.controlNumber ||
      record.tenantId !== stored.tenantId
    ) {
      throw new RcmShadowError('CLAIM_VERSION', 'stale or conflicting claim write');
    }
    this.claims.set(record.claimId, structuredClone(record));
  }

  public get(claimId: string): ClaimRecord | undefined {
    const stored = this.claims.get(claimId);
    return stored ? structuredClone(stored) : undefined;
  }

  public byControlNumber(tenantId: string, controlNumber: string): ClaimRecord | undefined {
    const claimId = this.controls.get(controlKey(tenantId, controlNumber));
    return claimId === undefined ? undefined : this.get(claimId);
  }

  public list(): readonly ClaimRecord[] {
    return [...this.claims.values()].map((record) => structuredClone(record));
  }

  public hasHandledResponse(responseId: string): boolean {
    return this.responseIds.has(responseId);
  }

  public markResponseHandled(responseId: string): void {
    this.responseIds.add(responseId);
  }

  public parkResponse(response: ClaimResponse): void {
    this.parked.set(response.responseId, structuredClone(response));
  }

  public unparkResponse(responseId: string): void {
    this.parked.delete(responseId);
  }

  public parkedResponses(tenantId: string, controlNumber: string): readonly ClaimResponse[] {
    return [...this.parked.values()]
      .filter(
        (response) => response.tenantId === tenantId && response.controlNumber === controlNumber,
      )
      .map((response) => structuredClone(response));
  }

  public recordConflict(conflict: ResponseConflict): void {
    this.conflictLog.push(structuredClone(conflict));
  }

  public conflicts(): readonly ResponseConflict[] {
    return this.conflictLog.map((conflict) => structuredClone(conflict));
  }

  public recordOrphanResponse(response: ClaimResponse): void {
    this.orphans.push(structuredClone(response));
  }

  public orphanResponses(): readonly ClaimResponse[] {
    return this.orphans.map((response) => structuredClone(response));
  }
}
