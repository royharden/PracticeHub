/**
 * Results release under information blocking (WP-063; R6-REQ-061).
 *
 * A result is held only for its category's clinician-review window and is
 * auto-released at that deadline. The only way to keep a result back past the
 * deadline is a reason-coded, time-bounded information-blocking exception that
 * the patient can see: a silent denial cannot be represented. Release never
 * reads payment state, and the fees exception cannot hold a patient's access.
 */

export class ResultsReleaseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ResultsReleaseError';
  }
}

export const exceptionCodes = [
  'preventing-harm',
  'privacy',
  'security',
  'infeasibility',
  'health-it-performance',
] as const;
export type ExceptionCode = (typeof exceptionCodes)[number];

/** Codes that may never hold a patient's own results. */
const refusedHoldCodes = new Set(['fees', 'payment', 'balance-due', 'licensing']);

export interface ReleasePolicy {
  readonly category: string;
  readonly reviewWindowHours: number;
  readonly synthetic: true;
}

export interface ResultScope {
  readonly tenantId: string;
  readonly personId: string;
  readonly resultId: string;
}

export interface InfoBlockingException {
  readonly code: ExceptionCode;
  readonly reasonText: string;
  readonly determinedBy: string;
  readonly expiresAt: string;
  readonly patientNotice: string;
}

export type ResultEvent =
  | { readonly kind: 'resulted'; readonly at: string; readonly releaseDueAt: string }
  | {
      readonly kind: 'released';
      readonly at: string;
      readonly by: 'clinician' | 'auto-deadline';
      readonly actorRef: string | null;
    }
  | {
      readonly kind: 'exception-applied';
      readonly at: string;
      readonly exception: InfoBlockingException;
    }
  | { readonly kind: 'exception-lapsed'; readonly at: string; readonly code: ExceptionCode }
  | {
      readonly kind: 'exception-superseded';
      readonly at: string;
      readonly previous: InfoBlockingException;
      readonly reason: string;
      readonly by: string;
    };

/** Explicit replacement of a live exception; without it a live exception is never replaced. */
export interface ExceptionSupersession {
  readonly reason: string;
  readonly by: string;
}

export interface ResultsReleaseOptions {
  /** Longest an information-blocking exception may run, in days (default 90); per-tenant overrides. */
  readonly maxExceptionDays?: number;
  readonly maxExceptionDaysByTenant?: Readonly<Record<string, number>>;
  /** Clock used when `patientView` is called without `asOf`, so the deadline holds without a sweep. */
  readonly now?: () => string;
}

export const DEFAULT_MAX_EXCEPTION_DAYS = 90;

export interface HeldResult {
  readonly scope: ResultScope;
  readonly category: string;
  readonly resultedAt: string;
  readonly releaseDueAt: string;
  readonly releasedAt: string | null;
  readonly exception: InfoBlockingException | null;
  readonly events: readonly ResultEvent[];
}

export type PatientResultView =
  | { readonly status: 'released'; readonly resultId: string; readonly releasedAt: string }
  | { readonly status: 'in-review'; readonly resultId: string; readonly availableBy: string }
  | {
      readonly status: 'withheld';
      readonly resultId: string;
      readonly exceptionCode: ExceptionCode;
      readonly notice: string;
      readonly reviewBy: string;
    };

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

/** Epoch ms of an instant, or a ResultsReleaseError (never a raw RangeError) when unparseable. */
function instantMs(value: string, field: string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new ResultsReleaseError(`${field} is not a valid instant: ${String(value)}`);
  }
  return ms;
}

function resultKey(tenantId: string, resultId: string): string {
  return `${tenantId}\u001f${resultId}`;
}

export class ResultsReleaseService {
  private readonly policies = new Map<string, ReleasePolicy>();
  /** Keyed by (tenant, result id): result ids are tenant-scoped. */
  private readonly results = new Map<string, HeldResult>();

  public constructor(
    policies: readonly ReleasePolicy[],
    private readonly options: ResultsReleaseOptions = {},
  ) {
    for (const policy of policies) {
      if (!Number.isFinite(policy.reviewWindowHours) || policy.reviewWindowHours < 0) {
        throw new ResultsReleaseError(`invalid review window for ${policy.category}`);
      }
      this.policies.set(policy.category, policy);
    }
    const limits = [
      options.maxExceptionDays,
      ...Object.values(options.maxExceptionDaysByTenant ?? {}),
    ];
    for (const limit of limits) {
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        throw new ResultsReleaseError(
          'the maximum exception duration must be a positive number of days',
        );
      }
    }
  }

  public recordResult(scope: ResultScope, category: string, resultedAt: string): HeldResult {
    if (this.results.has(resultKey(scope.tenantId, scope.resultId))) {
      throw new ResultsReleaseError(`result ${scope.resultId} already recorded`);
    }
    const resultedMs = instantMs(resultedAt, 'resultedAt');
    const policy = this.policies.get(category);
    if (policy === undefined) {
      // Fail toward release: an unknown category gets no hold window.
      return this.store(scope, category, resultedAt, resultedAt);
    }
    const due = new Date(resultedMs + policy.reviewWindowHours * hourMs).toISOString();
    return this.store(scope, category, resultedAt, due);
  }

  public clinicianRelease(
    resultId: string,
    clinicianRef: string,
    at: string,
    tenantId?: string,
  ): HeldResult {
    instantMs(at, 'at');
    const result = this.settle(this.require(resultId, tenantId), at);
    if (result.releasedAt !== null) {
      return result;
    }
    return this.release(result, at, 'clinician', clinicianRef);
  }

  /** The longest exception this tenant allows, in days. */
  public maxExceptionDays(tenantId: string): number {
    return (
      this.options.maxExceptionDaysByTenant?.[tenantId] ??
      this.options.maxExceptionDays ??
      DEFAULT_MAX_EXCEPTION_DAYS
    );
  }

  /**
   * Apply a reason-coded information-blocking exception. `code` is typed, but
   * callers crossing a trust boundary pass strings, so it is re-checked here.
   * The release deadline is effective at `at` without a sweep; the exception
   * runs no longer than the tenant maximum; a live exception is replaced only
   * by an explicit, recorded supersession.
   */
  public applyException(
    resultId: string,
    exception: InfoBlockingException,
    at: string,
    supersede?: ExceptionSupersession,
    tenantId?: string,
  ): HeldResult {
    const atMs = instantMs(at, 'at');
    const result = this.settle(this.require(resultId, tenantId), at);
    const code: string = exception.code;
    if (refusedHoldCodes.has(code)) {
      throw new ResultsReleaseError(`${code} cannot hold a patient's access to results`);
    }
    if (!(exceptionCodes as readonly string[]).includes(code)) {
      throw new ResultsReleaseError(`unknown information-blocking exception ${code}`);
    }
    if (result.releasedAt !== null) {
      throw new ResultsReleaseError('an exception cannot recall a released result');
    }
    if (exception.reasonText.trim() === '' || exception.patientNotice.trim() === '') {
      throw new ResultsReleaseError('an exception requires a reason and a patient notice');
    }
    if (exception.determinedBy.trim() === '') {
      throw new ResultsReleaseError('an exception requires an individual determination');
    }
    const expiresMs = instantMs(exception.expiresAt, 'exception expiresAt');
    if (expiresMs <= atMs) {
      throw new ResultsReleaseError('an exception must be time-bounded in the future');
    }
    const maxDays = this.maxExceptionDays(result.scope.tenantId);
    if (expiresMs - atMs > maxDays * dayMs) {
      throw new ResultsReleaseError(`an exception may run at most ${maxDays} days`);
    }
    const events: ResultEvent[] = [...result.events];
    if (result.exception !== null) {
      if (supersede === undefined || supersede.reason.trim() === '' || supersede.by.trim() === '') {
        throw new ResultsReleaseError(
          'a live exception is replaced only by an explicit supersession with a reason and a person',
        );
      }
      events.push({
        kind: 'exception-superseded',
        at,
        previous: result.exception,
        reason: supersede.reason,
        by: supersede.by,
      });
    }
    events.push({ kind: 'exception-applied', at, exception });
    const next: HeldResult = { ...result, exception, events };
    this.results.set(resultKey(result.scope.tenantId, result.scope.resultId), next);
    return next;
  }

  /** Release every result whose deadline passed and no live exception holds. */
  public sweep(asOf: string): readonly HeldResult[] {
    const released: HeldResult[] = [];
    const now = instantMs(asOf, 'asOf');
    for (const current of [...this.results.values()]) {
      let result = current;
      if (result.releasedAt !== null) {
        continue;
      }
      if (result.exception !== null && now >= Date.parse(result.exception.expiresAt)) {
        result = {
          ...result,
          exception: null,
          events: [
            ...result.events,
            { kind: 'exception-lapsed', at: asOf, code: result.exception.code },
          ],
        };
        this.results.set(resultKey(result.scope.tenantId, result.scope.resultId), result);
      }
      if (result.exception === null && now >= Date.parse(result.releaseDueAt)) {
        released.push(this.release(result, asOf, 'auto-deadline', null));
      }
    }
    return released;
  }

  /**
   * The patient always sees a state; a held result is never invisible. With
   * `asOf` (or the configured clock) the deadline and exception expiry take
   * effect at that instant, whether or not a sweep has run.
   */
  public patientView(
    tenantId: string,
    personId: string,
    resultId: string,
    asOf?: string,
  ): PatientResultView {
    const found = this.results.get(resultKey(tenantId, resultId));
    if (found === undefined) {
      // Same message as before for an id held by another tenant or patient.
      if ([...this.results.values()].some((item) => item.scope.resultId === resultId)) {
        throw new ResultsReleaseError('result is not in this patient scope');
      }
      throw new ResultsReleaseError(`unknown result ${resultId}`);
    }
    if (found.scope.personId !== personId) {
      throw new ResultsReleaseError('result is not in this patient scope');
    }
    const effectiveAt = asOf ?? this.options.now?.();
    const result = effectiveAt === undefined ? found : this.settle(found, effectiveAt);
    if (result.releasedAt !== null) {
      return { status: 'released', resultId, releasedAt: result.releasedAt };
    }
    if (result.exception !== null) {
      return {
        status: 'withheld',
        resultId,
        exceptionCode: result.exception.code,
        notice: result.exception.patientNotice,
        reviewBy: result.exception.expiresAt,
      };
    }
    return { status: 'in-review', resultId, availableBy: result.releaseDueAt };
  }

  public get(resultId: string, tenantId?: string): HeldResult {
    return this.require(resultId, tenantId);
  }

  /**
   * Bring one result up to `asOf`: a lapsed exception lapses at its expiry and
   * a result past its deadline with no live exception is released at the
   * moment it became due (never later than `asOf`).
   */
  private settle(current: HeldResult, asOf: string): HeldResult {
    const now = instantMs(asOf, 'asOf');
    let result = current;
    if (result.releasedAt !== null) {
      return result;
    }
    if (result.exception !== null && now >= Date.parse(result.exception.expiresAt)) {
      result = {
        ...result,
        exception: null,
        events: [
          ...result.events,
          { kind: 'exception-lapsed', at: result.exception.expiresAt, code: result.exception.code },
        ],
      };
      this.results.set(resultKey(result.scope.tenantId, result.scope.resultId), result);
    }
    if (result.exception === null && now >= Date.parse(result.releaseDueAt)) {
      const lapsedAt = result.events.findLast((event) => event.kind === 'exception-lapsed')?.at;
      const dueMs = Math.max(
        Date.parse(result.releaseDueAt),
        lapsedAt === undefined ? 0 : Date.parse(lapsedAt),
      );
      return this.release(result, new Date(dueMs).toISOString(), 'auto-deadline', null);
    }
    return result;
  }

  private store(
    scope: ResultScope,
    category: string,
    resultedAt: string,
    releaseDueAt: string,
  ): HeldResult {
    const result: HeldResult = {
      scope,
      category,
      resultedAt,
      releaseDueAt,
      releasedAt: null,
      exception: null,
      events: [{ kind: 'resulted', at: resultedAt, releaseDueAt }],
    };
    this.results.set(resultKey(scope.tenantId, scope.resultId), result);
    return result;
  }

  private release(
    result: HeldResult,
    at: string,
    by: 'clinician' | 'auto-deadline',
    actorRef: string | null,
  ): HeldResult {
    const next: HeldResult = {
      ...result,
      releasedAt: at,
      exception: null,
      events: [...result.events, { kind: 'released', at, by, actorRef }],
    };
    this.results.set(resultKey(result.scope.tenantId, result.scope.resultId), next);
    return next;
  }

  /**
   * Resolve a result. With a tenant the lookup is exact; without one (the
   * original API) it succeeds only when exactly one tenant holds that id.
   */
  private require(resultId: string, tenantId?: string): HeldResult {
    if (tenantId !== undefined) {
      const exact = this.results.get(resultKey(tenantId, resultId));
      if (exact === undefined) {
        throw new ResultsReleaseError(`unknown result ${resultId}`);
      }
      return exact;
    }
    const matches = [...this.results.values()].filter((item) => item.scope.resultId === resultId);
    if (matches.length > 1) {
      throw new ResultsReleaseError(
        `result ${resultId} exists in more than one tenant; name the tenant`,
      );
    }
    const result = matches[0];
    if (result === undefined) {
      throw new ResultsReleaseError(`unknown result ${resultId}`);
    }
    return result;
  }
}
