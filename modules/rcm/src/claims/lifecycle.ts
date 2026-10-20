import { RcmShadowError } from '../contracts.js';
import { applyRulePacks, type ClaimLine, type RulePack } from '../edit-library.js';
import type { ClearinghouseRouter, RailId } from '../router.js';
import type { ClaimResponse, ClearinghousePort } from './ch-sim.js';
import { assertTransition, CLAIM_TRANSITIONS, type ClaimState } from './state-machine.js';
import type {
  ClaimException,
  ClaimRecord,
  ClaimStore,
  ExceptionResolution,
  ResponseConflict,
} from './store.js';

export interface ClaimSubmission {
  readonly claimId: string;
  readonly tenantId: string;
  readonly payerId: string;
  readonly controlNumber: string;
  readonly totalMinor: number;
  readonly lines: readonly ClaimLine[];
}

export type CrashPoint = 'before-call' | 'after-call';

export interface LifecycleFaults {
  /** Called at each crash point; a test hook throws `SimulatedCrash` here. */
  crashAt?(point: CrashPoint, claimId: string): void;
}

export class SimulatedCrash extends Error {
  public constructor(readonly point: CrashPoint) {
    super(`simulated process death ${point}`);
    this.name = 'SimulatedCrash';
  }
}

export interface ClaimLifecycleOptions {
  readonly store: ClaimStore;
  readonly router: ClearinghouseRouter;
  readonly rails: readonly ClearinghousePort[];
  readonly clock: () => number;
  /** A claim with no 999 or 277CA after this long is an orphan. */
  readonly orphanWindowMs: number;
  readonly rulePacks?: readonly RulePack[];
  readonly exceptionOwner?: string;
  readonly faults?: LifecycleFaults;
  /** Most parked responses one drain pass re-tries; the rest wait for the next advance. Default 100. */
  readonly maxParkedDrainPerCall?: number;
}

export interface DrainReport {
  readonly claimId: string;
  /** Parked responses that left the parked store in this sweep (applied, superseded or conflicted). */
  readonly applied: number;
  /** Parked responses still held, for example ones that still cannot apply, or over the cap. */
  readonly remaining: number;
}

export interface ExceptionResolutionResult {
  readonly claim: ClaimRecord;
  /** The parked responses closed by the resolution, for the resolver's record. */
  readonly closed: readonly ClaimResponse[];
}

/**
 * applied: the claim advanced. duplicate: this response id was already handled.
 * orphan: no claim has the control number. parked: held until the claim can take it.
 * superseded: agrees with what the claim already records. conflict: contradicts it; owned.
 */
export type IngestStatus =
  'applied' | 'duplicate' | 'orphan' | 'parked' | 'superseded' | 'conflict';

export interface IngestResult {
  readonly status: IngestStatus;
  readonly claim: ClaimRecord | null;
}

export interface RecoveryReport {
  readonly recoveredToUnknown: readonly string[];
  readonly reconciled: readonly string[];
  readonly resent: readonly string[];
  readonly exceptions: readonly string[];
}

export interface OrphanRecoveryReport {
  readonly answered: readonly string[];
  readonly resubmitted: readonly string[];
  readonly exceptions: readonly string[];
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ORPHAN_STATES: readonly ClaimState[] = ['submitted', 'ack-accepted'];
/** States that already imply an accepted 999. */
const AFTER_ACK_ACCEPTED: readonly ClaimState[] = [
  'ack-accepted',
  'payer-accepted',
  'payer-rejected',
  'finalized',
];
/** States where a 277 status can arrive before the 277CA it depends on. */
const AWAITING_PAYER_ACK: readonly ClaimState[] = ['unknown', 'submitted', 'ack-accepted'];

type RecordPatch = Partial<Pick<ClaimRecord, 'railId' | 'resubmissions' | 'exception'>>;

/**
 * WP-086 claim lifecycle: validation, 837, 999/277CA, status, and orphan
 * recovery. State is written before and after every clearinghouse call, and
 * the engine holds no claim state in memory, so a new engine over the same
 * store behaves as a restarted process.
 */
export class ClaimLifecycle {
  private readonly rails = new Map<RailId, ClearinghousePort>();
  private readonly owner: string;
  private drainBudget: number | null = null;

  public constructor(private readonly options: ClaimLifecycleOptions) {
    if (!Number.isSafeInteger(options.orphanWindowMs) || options.orphanWindowMs <= 0) {
      throw new RcmShadowError('CLAIM_WINDOW', 'orphanWindowMs must be a positive integer');
    }
    for (const rail of options.rails) {
      if (this.rails.has(rail.railId)) {
        throw new RcmShadowError('CLAIM_RAIL', 'each rail may be bound once');
      }
      this.rails.set(rail.railId, rail);
    }
    this.owner = options.exceptionOwner ?? 'rcm-lead';
  }

  public register(submission: ClaimSubmission): ClaimRecord {
    for (const field of ['claimId', 'tenantId', 'payerId', 'controlNumber'] as const) {
      if (!TOKEN.test(submission[field])) {
        throw new RcmShadowError('CLAIM_INVALID', `${field} must be a token`);
      }
    }
    if (!Number.isSafeInteger(submission.totalMinor) || submission.totalMinor <= 0) {
      throw new RcmShadowError('CLAIM_INVALID', 'totalMinor must be a positive safe integer');
    }
    if (submission.lines.length === 0) {
      throw new RcmShadowError('CLAIM_INVALID', 'a claim needs at least one line');
    }
    if (this.options.store.byControlNumber(submission.tenantId, submission.controlNumber)) {
      throw new RcmShadowError('CLAIM_DUPLICATE_CONTROL', 'control number is already used');
    }
    // Per family, only the pack version in force on each line's service date fires (WP-084).
    const edits = applyRulePacks(this.options.rulePacks ?? [], submission.lines);
    const state: ClaimState = edits.length === 0 ? 'validated' : 'invalid';
    const at = this.options.clock();
    const record: ClaimRecord = {
      claimId: submission.claimId,
      tenantId: submission.tenantId,
      payerId: submission.payerId,
      controlNumber: submission.controlNumber,
      totalMinor: submission.totalMinor,
      lines: submission.lines,
      edits,
      state,
      railId: null,
      resubmissions: 0,
      stateChangedAt: at,
      version: 1,
      exception: null,
      history: [{ from: null, to: state, at, reason: 'registered' }],
    };
    this.options.store.insert(record);
    return this.require(record.claimId);
  }

  public submit(claimId: string): ClaimRecord {
    const record = this.require(claimId);
    assertTransition(record.state, 'submitting');
    const picked = this.options.router.submitBatch([
      { claimId: record.claimId, payerId: record.payerId },
    ]).submitted[0];
    if (!picked) {
      throw new RcmShadowError('CLAIM_RAIL', 'router produced no rail for the claim');
    }
    return this.send(record, picked.railId, 'submit', {});
  }

  public get(claimId: string): ClaimRecord | undefined {
    return this.options.store.get(claimId);
  }

  /**
   * Applies one inbound response. A response id is recorded as handled only
   * once it has been applied, superseded, raised as a conflict or queued as
   * an orphan. A response that arrives before its claim can take it is
   * parked and re-applied whenever the claim advances, so nothing is lost to
   * arrival order.
   */
  public ingest(response: ClaimResponse): IngestResult {
    const { store } = this.options;
    if (store.hasHandledResponse(response.responseId)) {
      return { status: 'duplicate', claim: null };
    }
    const record = store.byControlNumber(response.tenantId, response.controlNumber);
    if (!record) {
      store.recordOrphanResponse(response);
      store.markResponseHandled(response.responseId);
      return { status: 'orphan', claim: null };
    }
    const result = this.applyResponse(record, response);
    if (result.status === 'parked') {
      store.parkResponse(response);
      return result;
    }
    store.unparkResponse(response.responseId);
    store.markResponseHandled(response.responseId);
    if (result.status === 'applied') {
      this.drainParked(record.claimId);
      return { status: 'applied', claim: this.require(record.claimId) };
    }
    return result;
  }

  /** Responses held until their claim can take them. */
  public parkedResponses(claimId: string): readonly ClaimResponse[] {
    const record = this.require(claimId);
    return this.options.store.parkedResponses(record.tenantId, record.controlNumber);
  }

  private applyResponse(start: ClaimRecord, response: ClaimResponse): IngestResult {
    let record = start;
    const { kind, outcome } = response;
    if (record.state === 'exception') {
      // Never consumed silently: the response is logged once against the claim for its owner,
      // and parked so it can be re-applied when the exception is resolved.
      const alreadyParked = this.options.store
        .parkedResponses(record.tenantId, record.controlNumber)
        .some((parked) => parked.responseId === response.responseId);
      if (!alreadyParked) {
        this.options.store.recordConflict({
          response,
          claimId: record.claimId,
          stateAtArrival: record.state,
          owner: this.owner,
        });
      }
      return { status: 'parked', claim: record };
    }
    if (kind === '277' && outcome === 'pending') {
      return { status: 'superseded', claim: record };
    }
    if (record.state === 'submitting') {
      return { status: 'parked', claim: record };
    }
    if (kind === '999') {
      if (record.state === 'unknown') {
        record = this.move(record, 'submitted', 'receipt-proven-by-999', {
          railId: response.railId,
        });
      }
      if (record.state === 'submitted') {
        record = this.move(record, outcome === 'accepted' ? 'ack-accepted' : 'ack-rejected', '999');
        return { status: 'applied', claim: record };
      }
      const agrees =
        outcome === 'accepted'
          ? AFTER_ACK_ACCEPTED.includes(record.state)
          : record.state === 'ack-rejected';
      return agrees
        ? { status: 'superseded', claim: record }
        : this.conflict(record, response, 'contradictory-999');
    }
    if (kind === '277CA') {
      if (record.state === 'unknown') {
        record = this.move(record, 'submitted', 'receipt-proven-by-277CA', {
          railId: response.railId,
        });
      }
      if (record.state === 'submitted') {
        record = this.move(record, 'ack-accepted', 'implied-by-277CA');
      }
      if (record.state === 'ack-accepted') {
        record = this.move(
          record,
          outcome === 'accepted' ? 'payer-accepted' : 'payer-rejected',
          '277CA',
        );
        return { status: 'applied', claim: record };
      }
      const agrees =
        outcome === 'accepted'
          ? record.state === 'payer-accepted' || record.state === 'finalized'
          : record.state === 'payer-rejected';
      return agrees
        ? { status: 'superseded', claim: record }
        : this.conflict(record, response, 'contradictory-277CA');
    }
    if (record.state === 'payer-accepted') {
      record = this.move(record, 'finalized', '277');
      return { status: 'applied', claim: record };
    }
    if (record.state === 'finalized') {
      return { status: 'superseded', claim: record };
    }
    if (AWAITING_PAYER_ACK.includes(record.state)) {
      return { status: 'parked', claim: record };
    }
    return this.conflict(record, response, 'contradictory-277');
  }

  /** A contradicting response is logged with an owner and, where the state allows, raises the claim to `exception`. */
  private conflict(record: ClaimRecord, response: ClaimResponse, reason: string): IngestResult {
    this.options.store.recordConflict({
      response,
      claimId: record.claimId,
      stateAtArrival: record.state,
      owner: this.owner,
    });
    const claim = CLAIM_TRANSITIONS[record.state].includes('exception')
      ? this.toException(record, reason)
      : record;
    return { status: 'conflict', claim };
  }

  /**
   * Re-tries parked responses after the claim advanced. Each call re-tries at most
   * `maxParkedDrainPerCall` responses; anything left stays parked for the next advance.
   */
  private drainParked(claimId: string): void {
    // One budget per top-level drain: a response applied here drains again recursively through
    // ingest(), and those nested passes spend the same budget.
    const outermost = this.drainBudget === null;
    if (outermost) {
      this.drainBudget = this.options.maxParkedDrainPerCall ?? 100;
    }
    try {
      for (;;) {
        const record = this.require(claimId);
        const parked = this.options.store.parkedResponses(record.tenantId, record.controlNumber);
        const progressed = parked.some((response) => {
          if ((this.drainBudget ?? 0) <= 0) {
            return false;
          }
          this.drainBudget = (this.drainBudget ?? 0) - 1;
          return this.ingest(response).status !== 'parked';
        });
        if (!progressed || (this.drainBudget ?? 0) <= 0) {
          return;
        }
      }
    } finally {
      if (outermost) {
        this.drainBudget = null;
      }
    }
  }

  /**
   * Sweep for parked responses (NR-182). A response left parked because a drain hit its cap is
   * otherwise re-tried only when the claim next advances; this drains every claim that still has
   * parked responses, each within one `maxParkedDrainPerCall` budget, without waiting for an advance.
   * Run it on a schedule. Returns what each claim applied and what it still holds.
   */
  public drainAllParked(): readonly DrainReport[] {
    const { store } = this.options;
    const reports: DrainReport[] = [];
    for (const record of store.list()) {
      const before = store.parkedResponses(record.tenantId, record.controlNumber).length;
      if (before === 0) {
        continue;
      }
      this.drainParked(record.claimId);
      const remaining = store.parkedResponses(record.tenantId, record.controlNumber).length;
      reports.push({ claimId: record.claimId, applied: before - remaining, remaining });
    }
    return reports;
  }

  /**
   * Resolves a claim's exception. `exception` stays terminal in the frozen state machine, so the
   * responses parked against it cannot be re-applied to this claim; they are closed instead, with
   * the resolver as owner, recorded on the exception and returned. A response that arrives after
   * the resolution is parked and logged again, never consumed silently.
   */
  public resolveException(
    claimId: string,
    input: { readonly by: string; readonly reason: string },
  ): ExceptionResolutionResult {
    const record = this.require(claimId);
    if (record.state !== 'exception' || record.exception === null) {
      throw new RcmShadowError('CLAIM_STATE', 'only a claim in exception can be resolved');
    }
    if (!TOKEN.test(input.by) || input.reason.trim() === '') {
      throw new RcmShadowError('CLAIM_INVALID', 'a resolution needs a resolver token and a reason');
    }
    const { store } = this.options;
    const closed = store.parkedResponses(record.tenantId, record.controlNumber);
    for (const response of closed) {
      store.unparkResponse(response.responseId);
      store.markResponseHandled(response.responseId);
    }
    const at = this.options.clock();
    const resolution: ExceptionResolution = {
      by: input.by,
      at,
      reason: input.reason,
      closedResponseIds: [
        ...(record.exception.resolution?.closedResponseIds ?? []),
        ...closed.map((response) => response.responseId),
      ],
    };
    const next: ClaimRecord = {
      ...record,
      exception: { ...record.exception, resolution },
      version: record.version + 1,
      history: [
        ...record.history,
        { from: 'exception', to: 'exception', at, reason: `exception-resolved: ${input.reason}` },
      ],
    };
    store.put(next);
    return { claim: next, closed };
  }

  public conflicts(): readonly ResponseConflict[] {
    return this.options.store.conflicts();
  }

  public orphanResponses(): readonly ClaimResponse[] {
    return this.options.store.orphanResponses();
  }

  /**
   * Crash recovery. A claim left `submitting` becomes `unknown`; every
   * `unknown` claim is reconciled by claim status on every rail before any
   * resend, and is resent with the same control number only when no rail
   * holds it.
   */
  public recover(): RecoveryReport {
    const recoveredToUnknown: string[] = [];
    const reconciled: string[] = [];
    const resent: string[] = [];
    const exceptions: string[] = [];
    for (const record of this.options.store.list()) {
      if (record.state === 'submitting') {
        this.move(record, 'unknown', 'crash-recovery');
        recoveredToUnknown.push(record.claimId);
      }
    }
    for (const record of this.options.store.list()) {
      if (record.state !== 'unknown') {
        continue;
      }
      const holders = [...this.rails.values()].filter(
        (rail) => rail.status(record.tenantId, record.controlNumber).known,
      );
      if (holders.length > 1) {
        this.toException(record, 'accepted-on-multiple-rails');
        exceptions.push(record.claimId);
        continue;
      }
      const holder = holders[0];
      if (holder) {
        this.move(record, 'submitted', 'reconciled-by-status', { railId: holder.railId });
        this.drainParked(record.claimId);
        this.applyRailResponses(record.claimId);
        reconciled.push(record.claimId);
        continue;
      }
      if (record.railId === null) {
        throw new RcmShadowError('CLAIM_RAIL', 'an unknown claim must name its rail');
      }
      this.send(record, record.railId, 'resend-after-status-unknown', {});
      resent.push(record.claimId);
    }
    return { recoveredToUnknown, reconciled, resent, exceptions };
  }

  /** Claims that have had no 999 or 277CA for the orphan window. */
  public orphans(): readonly ClaimRecord[] {
    const now = this.options.clock();
    return this.options.store
      .list()
      .filter(
        (record) =>
          ORPHAN_STATES.includes(record.state) &&
          now - record.stateChangedAt >= this.options.orphanWindowMs,
      );
  }

  /**
   * Orphan recovery. Responses the rails already hold are applied first. A
   * claim no rail holds is resubmitted once, with its original control
   * number; any later orphan goes to an owned exception queue.
   */
  public recoverOrphans(): OrphanRecoveryReport {
    const answered: string[] = [];
    const resubmitted: string[] = [];
    const exceptions: string[] = [];
    for (const orphan of this.orphans()) {
      this.drainParked(orphan.claimId);
      this.applyRailResponses(orphan.claimId);
      const record = this.require(orphan.claimId);
      if (record.version !== orphan.version) {
        answered.push(record.claimId);
        continue;
      }
      const held = [...this.rails.values()].some(
        (rail) => rail.status(record.tenantId, record.controlNumber).known,
      );
      if (record.state === 'submitted' && !held && record.resubmissions === 0) {
        if (record.railId === null) {
          throw new RcmShadowError('CLAIM_RAIL', 'a submitted claim must name its rail');
        }
        this.send(record, record.railId, 'orphan-resubmit', { resubmissions: 1 });
        resubmitted.push(record.claimId);
        continue;
      }
      const reason =
        record.state === 'ack-accepted'
          ? 'payer-ack-missing'
          : held
            ? 'ack-missing'
            : 'orphan-resubmit-exhausted';
      this.toException(record, reason);
      exceptions.push(record.claimId);
    }
    return { answered, resubmitted, exceptions };
  }

  private send(
    record: ClaimRecord,
    railId: RailId,
    reason: string,
    patch: RecordPatch,
  ): ClaimRecord {
    const rail = this.rails.get(railId);
    if (!rail) {
      throw new RcmShadowError('CLAIM_RAIL', `rail ${railId} is not bound`);
    }
    const pending = this.move(record, 'submitting', reason, { ...patch, railId });
    this.crash('before-call', pending.claimId);
    try {
      rail.submit837({
        tenantId: pending.tenantId,
        claimId: pending.claimId,
        controlNumber: pending.controlNumber,
        totalMinor: pending.totalMinor,
      });
    } catch {
      return this.move(pending, 'unknown', 'rail-call-failed');
    }
    this.crash('after-call', pending.claimId);
    this.move(pending, 'submitted', 'rail-received');
    this.drainParked(pending.claimId);
    return this.require(pending.claimId);
  }

  private applyRailResponses(claimId: string): void {
    const record = this.require(claimId);
    const responses = [...this.rails.values()].flatMap(
      (rail) => rail.status(record.tenantId, record.controlNumber).responses,
    );
    for (const response of responses) {
      this.ingest(response);
    }
  }

  private toException(record: ClaimRecord, reason: string): ClaimRecord {
    const exception: ClaimException = { reason, owner: this.owner };
    return this.move(record, 'exception', reason, { exception });
  }

  private move(
    record: ClaimRecord,
    to: ClaimState,
    reason: string,
    patch: RecordPatch = {},
  ): ClaimRecord {
    assertTransition(record.state, to);
    const at = this.options.clock();
    const next: ClaimRecord = {
      ...record,
      ...patch,
      state: to,
      version: record.version + 1,
      stateChangedAt: at,
      history: [...record.history, { from: record.state, to, at, reason }],
    };
    this.options.store.put(next);
    return next;
  }

  private crash(point: CrashPoint, claimId: string): void {
    this.options.faults?.crashAt?.(point, claimId);
  }

  private require(claimId: string): ClaimRecord {
    const record = this.options.store.get(claimId);
    if (!record) {
      throw new RcmShadowError('CLAIM_UNKNOWN', 'claim is not registered');
    }
    return record;
  }
}
