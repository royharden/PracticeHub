import type { TouchpointRegistry } from './touchpoint-registry.js';
import type { CsatSample, KillReason, ReviewFlag, TenantId, TouchpointId } from './types.js';
import { KillSwitchError } from './types.js';

export interface Breach {
  readonly reason: KillReason;
  readonly rationale: string;
}

export class CsatMonitor {
  private readonly samples: CsatSample[] = [];

  public constructor(private readonly registry: TouchpointRegistry) {}

  public record(sample: CsatSample): void {
    this.registry.require(sample.tenantId, sample.touchpointId);
    this.samples.push(Object.freeze({ ...sample }));
  }

  public lastSampleAt(tenantId: TenantId, touchpointId: TouchpointId): string | undefined {
    return [...this.samples]
      .reverse()
      .find((row) => row.tenantId === tenantId && row.touchpointId === touchpointId)?.at;
  }

  public evaluate(tenantId: TenantId, touchpointId: TouchpointId, nowMs: number): Breach | null {
    const def = this.registry.require(tenantId, touchpointId);
    const rows = this.samples.filter(
      (row) => row.tenantId === tenantId && row.touchpointId === touchpointId,
    );
    const attributed = rows.filter((row) => row.attributionTag === 'ai-touchpoint');
    if (rows.length === 0) {
      throw new KillSwitchError('missing instrumentation', 'missing-instrumentation');
    }
    const newest = rows.reduce((a, b) => (a.at > b.at ? a : b));
    const newestMs = Date.parse(newest.at);
    if (!Number.isFinite(newestMs) || nowMs - newestMs > def.instrumentationTtlMs) {
      throw new KillSwitchError('stale instrumentation', 'stale-instrumentation');
    }
    const sentinel = attributed.find((row) => row.sentinel);
    if (sentinel !== undefined) {
      return {
        reason: 'sentinel',
        rationale: `sentinel ${sentinel.inFlightRef ?? sentinel.at}`,
      };
    }
    const disclosure = attributed.find((row) => row.deceptiveDisclosure);
    if (disclosure !== undefined) {
      return {
        reason: 'deceptive-disclosure',
        rationale: `deceptive-disclosure ${disclosure.at}`,
      };
    }
    if (attributed.some((row) => row.missedEscalation)) {
      return { reason: 'missed-escalation', rationale: 'missed escalation on touchpoint' };
    }
    if (attributed.length < def.minSample) {
      return null;
    }
    const mean = attributed.reduce((sum, row) => sum + row.score, 0) / attributed.length;
    if (def.csatBaseline - mean > def.csatDropThreshold + Number.EPSILON) {
      return {
        reason: 'csat-drop',
        rationale: `mean ${mean.toFixed(3)} vs baseline ${def.csatBaseline}`,
      };
    }
    const complaintRate =
      attributed.filter((row) => row.complaint || row.optOut).length / attributed.length;
    if (complaintRate > def.complaintRateThreshold + Number.EPSILON) {
      return {
        reason: 'complaint-trend',
        rationale: `complaint/opt-out rate ${complaintRate.toFixed(3)}`,
      };
    }
    return null;
  }

  public containmentRate(tenantId: TenantId, touchpointId: TouchpointId): number {
    const rows = this.samples.filter(
      (row) =>
        row.tenantId === tenantId &&
        row.touchpointId === touchpointId &&
        row.attributionTag === 'ai-touchpoint',
    );
    if (rows.length === 0) {
      return 0;
    }
    return rows.filter((row) => row.contained).length / rows.length;
  }

  public reviewFlag(
    tenantId: TenantId,
    touchpointId: TouchpointId,
    at: string,
    kind: ReviewFlag['kind'],
  ): ReviewFlag {
    const def = this.registry.require(tenantId, touchpointId);
    const due = new Date(Date.parse(at) + def.reviewSlaMs).toISOString();
    return Object.freeze({
      tenantId,
      touchpointId,
      kind,
      slaDueAt: due,
      at,
      synthetic: true,
    });
  }
}
