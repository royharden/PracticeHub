export type TouchpointId = string & { readonly __brand: 'TouchpointId' };
export type TenantId = string & { readonly __brand: 'TenantId' };

export type SurfacePath = 'ai' | 'human-only';

export type KillReason =
  | 'csat-drop'
  | 'complaint-trend'
  | 'missed-escalation'
  | 'missing-instrumentation'
  | 'stale-instrumentation'
  | 'sentinel'
  | 'deceptive-disclosure';

export interface TouchpointDefinition {
  readonly contractId: 'ai-kill-switch-touchpoint/v1';
  readonly tenantId: TenantId;
  readonly touchpointId: TouchpointId;
  readonly label: string;
  readonly memberFacing: true;
  readonly csatBaseline: number;
  readonly csatDropThreshold: number;
  readonly minSample: number;
  readonly complaintRateThreshold: number;
  readonly instrumentationTtlMs: number;
  readonly reviewSlaMs: number;
  readonly synthetic: true;
}

export interface CsatSample {
  readonly tenantId: TenantId;
  readonly touchpointId: TouchpointId;
  readonly at: string;
  readonly score: number;
  readonly complaint: boolean;
  readonly optOut: boolean;
  readonly missedEscalation: boolean;
  readonly deceptiveDisclosure: boolean;
  readonly sentinel: boolean;
  readonly cohort: string;
  readonly attributionTag: 'ai-touchpoint' | 'general-service';
  readonly contained: boolean;
  readonly inFlightRef: string | null;
  readonly synthetic: true;
}

export interface ReviewFlag {
  readonly tenantId: TenantId;
  readonly touchpointId: TouchpointId;
  readonly kind: 'auto-kill' | 'owner-review';
  readonly slaDueAt: string;
  readonly at: string;
  readonly synthetic: true;
}

export interface KillRecord {
  readonly tenantId: TenantId;
  readonly touchpointId: TouchpointId;
  readonly killedAt: string;
  readonly reason: KillReason;
  readonly alerted: readonly ['ai-safety-owner', 'governance-board'];
  readonly path: 'human-only';
  readonly inFlightHandoffs: readonly string[];
  readonly rationale: string;
  readonly synthetic: true;
}

export interface HumanHandoff {
  readonly tenantId: TenantId;
  readonly touchpointId: TouchpointId;
  readonly inFlightRef: string;
  readonly handedOffAt: string;
  readonly deadEnd: false;
  readonly synthetic: true;
}

export interface GoldenSetEvidence {
  readonly contractId: 'wp101-eval-double/v1';
  readonly touchpointId: TouchpointId;
  readonly evalRunRef: string;
  readonly floorsMet: boolean;
  readonly synthetic: true;
}

export interface ReenableDecision {
  readonly tenantId: TenantId;
  readonly touchpointId: TouchpointId;
  readonly practiceManagerSignOff: string;
  readonly governanceBoardSignOff: string;
  readonly goldenSet: GoldenSetEvidence;
  readonly supervisedRepilotCleared: boolean;
  readonly decidedAt: string;
  readonly synthetic: true;
}

export class KillSwitchError extends Error {
  public override readonly name = 'KillSwitchError';
  public constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}
