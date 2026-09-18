import { CsatMonitor } from './csat-monitor.js';
import { HumanFallback } from './human-fallback.js';
import { TouchpointRegistry } from './touchpoint-registry.js';
import type {
  CsatSample,
  KillReason,
  KillRecord,
  ReviewFlag,
  SurfacePath,
  TenantId,
  TouchpointDefinition,
  TouchpointId,
} from './types.js';
import { KillSwitchError } from './types.js';

export class KillSwitchConsole {
  public readonly registry = new TouchpointRegistry();
  public readonly monitor = new CsatMonitor(this.registry);
  public readonly fallback = new HumanFallback();
  private readonly kills = new Map<string, KillRecord>();
  private readonly reviews = new Map<string, ReviewFlag>();

  public register(definition: TouchpointDefinition): void {
    this.registry.register(definition);
  }

  public path(tenantId: TenantId, touchpointId: TouchpointId): SurfacePath {
    return this.kills.has(key(tenantId, touchpointId)) ? 'human-only' : 'ai';
  }

  /** Gate a member-facing turn. Missing/stale instrumentation fails closed to human. */
  public admit(
    tenantId: TenantId,
    touchpointId: TouchpointId,
    at: string,
    nowMs: number,
    inFlightRef: string | null,
  ): SurfacePath {
    this.registry.require(tenantId, touchpointId);
    if (this.path(tenantId, touchpointId) === 'human-only') {
      if (inFlightRef !== null) {
        this.fallback.handoff({ tenantId, touchpointId, inFlightRef, at });
      }
      return 'human-only';
    }
    try {
      const breach = this.monitor.evaluate(tenantId, touchpointId, nowMs);
      if (breach !== null) {
        this.kill({
          tenantId,
          touchpointId,
          at,
          reason: breach.reason,
          rationale: breach.rationale,
          inFlightRef,
        });
        return 'human-only';
      }
    } catch (error) {
      if (error instanceof KillSwitchError && error.code === 'missing-instrumentation') {
        this.kill({
          tenantId,
          touchpointId,
          at,
          reason: 'missing-instrumentation',
          rationale: error.message,
          inFlightRef,
        });
        return 'human-only';
      }
      if (error instanceof KillSwitchError && error.code === 'stale-instrumentation') {
        this.kill({
          tenantId,
          touchpointId,
          at,
          reason: 'stale-instrumentation',
          rationale: error.message,
          inFlightRef,
        });
        return 'human-only';
      }
      throw error;
    }
    return 'ai';
  }

  public recordAndMaybeKill(sample: CsatSample, nowMs: number): KillRecord | null {
    const existing = this.kills.get(key(sample.tenantId, sample.touchpointId));
    if (existing !== undefined) {
      if (sample.inFlightRef !== null) {
        this.fallback.handoff({
          tenantId: sample.tenantId,
          touchpointId: sample.touchpointId,
          inFlightRef: sample.inFlightRef,
          at: sample.at,
        });
      }
      return existing;
    }
    try {
      this.monitor.record(sample);
    } catch (error) {
      if (error instanceof KillSwitchError && error.code === 'unknown-touchpoint') {
        throw error;
      }
      throw error;
    }
    let reason: KillReason | null = null;
    let rationale = '';
    try {
      const breach = this.monitor.evaluate(sample.tenantId, sample.touchpointId, nowMs);
      if (breach !== null) {
        reason = breach.reason;
        rationale = breach.rationale;
      }
    } catch (error) {
      if (error instanceof KillSwitchError && error.code === 'missing-instrumentation') {
        reason = 'missing-instrumentation';
        rationale = error.message;
      } else if (error instanceof KillSwitchError && error.code === 'stale-instrumentation') {
        reason = 'stale-instrumentation';
        rationale = error.message;
      } else {
        throw error;
      }
    }
    if (reason === null) {
      return null;
    }
    return this.kill({
      tenantId: sample.tenantId,
      touchpointId: sample.touchpointId,
      at: sample.at,
      reason,
      rationale,
      inFlightRef: sample.inFlightRef,
    });
  }

  public kill(input: {
    readonly tenantId: TenantId;
    readonly touchpointId: TouchpointId;
    readonly at: string;
    readonly reason: KillReason;
    readonly rationale: string;
    readonly inFlightRef: string | null;
  }): KillRecord {
    this.registry.require(input.tenantId, input.touchpointId);
    const id = key(input.tenantId, input.touchpointId);
    const prior = this.kills.get(id);
    if (prior !== undefined) {
      return prior;
    }
    const handoffs =
      input.inFlightRef === null
        ? []
        : [
            this.fallback.handoff({
              tenantId: input.tenantId,
              touchpointId: input.touchpointId,
              inFlightRef: input.inFlightRef,
              at: input.at,
            }).inFlightRef,
          ];
    const record: KillRecord = Object.freeze({
      tenantId: input.tenantId,
      touchpointId: input.touchpointId,
      killedAt: input.at,
      reason: input.reason,
      alerted: ['ai-safety-owner', 'governance-board'] as const,
      path: 'human-only',
      inFlightHandoffs: handoffs,
      rationale: input.rationale,
      synthetic: true,
    });
    this.kills.set(id, record);
    this.reviews.set(
      id,
      this.monitor.reviewFlag(input.tenantId, input.touchpointId, input.at, 'auto-kill'),
    );
    return record;
  }

  public lastReview(tenantId: TenantId, touchpointId: TouchpointId): ReviewFlag | undefined {
    return this.reviews.get(key(tenantId, touchpointId));
  }

  public currentKill(tenantId: TenantId, touchpointId: TouchpointId): KillRecord | undefined {
    return this.kills.get(key(tenantId, touchpointId));
  }

  public assertNotToggle(tenantId: TenantId, touchpointId: TouchpointId): void {
    if (this.kills.has(key(tenantId, touchpointId))) {
      throw new KillSwitchError(
        'killed touchpoint cannot be silently re-enabled by a toggle',
        'silent-reenable-forbidden',
      );
    }
  }

  public releaseAfterGovernedReenable(tenantId: TenantId, touchpointId: TouchpointId): void {
    this.kills.delete(key(tenantId, touchpointId));
  }

  public disableThisControl(): never {
    throw new KillSwitchError(
      'the kill-switch itself cannot be disabled',
      'control-disable-forbidden',
    );
  }
}

function key(tenantId: TenantId, touchpointId: TouchpointId): string {
  return `${tenantId}\0${touchpointId}`;
}
