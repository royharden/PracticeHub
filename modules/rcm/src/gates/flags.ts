import { RcmShadowError } from '../contracts.js';

import { GATE_IDS, isIssuedDossier, parseGateInstant, type PromotionDossier } from './evaluate.js';

/**
 * Per-tenant, per-payer promotion flags. The ceiling is `shadow-ready`: WP-092 can say a payer's
 * shadow evidence clears every gate and has human sign-off, never make the payer live. The
 * incumbent stays the authority for every payer until a later, separately granted step.
 */
export type PayerFlagState = 'shadow' | 'shadow-ready' | 'rolled-back';

export type ApproverRole = 'compliance' | 'domain-owner' | 'practice-manager' | 'it-security';

export const REQUIRED_APPROVER_ROLES: readonly ApproverRole[] = [
  'compliance',
  'domain-owner',
  'practice-manager',
  'it-security',
];

export interface PromotionApproval {
  readonly role: ApproverRole;
  readonly approverId: string;
  readonly decision: 'approve' | 'reject' | 'more-evidence';
  readonly at: string;
}

/** The signed record a shadow-ready flag is set from. The dossier fixes the tenant. */
export interface SignedPromotion {
  readonly payerId: string;
  readonly dossier: PromotionDossier;
  readonly approvals: readonly PromotionApproval[];
  readonly monitoringOwner: string;
  readonly rollbackTarget: 'shadow';
  readonly at: string;
}

export type FlagEventKind = 'shadow-ready' | 'rollback' | 'kill-switch' | 'monitor-rollback';

export interface FlagEvent {
  readonly tenantId: string;
  readonly payerId: string;
  readonly kind: FlagEventKind;
  readonly from: PayerFlagState;
  readonly to: PayerFlagState;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
}

export type Authority = 'incumbent';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const HOUR_MS = 3_600_000;

interface FlagRecord {
  readonly tenantId: string;
  readonly payerId: string;
  state: PayerFlagState;
  since: string | null;
  monitoringOwner: string | null;
}

/**
 * One person's identity for separation of duties: NFKC, trimmed, case-folded. `person-1` and
 * `PERSON-1` are the same approver and cannot fill two roles or approve their own dossier.
 */
export function canonicalApproverId(id: string): string {
  return id.normalize('NFKC').trim().toLowerCase().normalize('NFKC');
}

function flagKey(tenantId: string, payerId: string): string {
  return `${tenantId}\u001f${payerId}`;
}

export class PromotionFlags {
  private readonly flags = new Map<string, FlagRecord>();
  private readonly events: FlagEvent[] = [];
  private lastAtMs = Number.NEGATIVE_INFINITY;

  public constructor(private readonly maxDossierAgeHours = 72) {
    if (!Number.isSafeInteger(maxDossierAgeHours) || maxDossierAgeHours <= 0) {
      throw new RcmShadowError(
        'FLAG_POLICY',
        'dossier age limit must be a positive whole number of hours',
      );
    }
  }

  public state(tenantId: string, payerId: string): PayerFlagState {
    return this.flags.get(flagKey(tenantId, payerId))?.state ?? 'shadow';
  }

  /** Always the incumbent: the harness's ceiling is shadow-ready, never live. */
  public authority(tenantId: string, payerId: string): Authority {
    this.state(tenantId, payerId);
    return 'incumbent';
  }

  public markShadowReady(signed: SignedPromotion): PayerFlagState {
    // Only an unmodified dossier issued by evaluatePromotion counts as gate evidence.
    if (!isIssuedDossier(signed.dossier)) {
      throw new RcmShadowError(
        'FLAG_DOSSIER',
        'dossier was not issued by evaluatePromotion or was altered',
      );
    }
    const { tenantId } = signed.dossier;
    const atMs = this.advance(signed.at);
    const current = this.record(tenantId, signed.payerId);
    if (current.state === 'shadow-ready') {
      throw new RcmShadowError('FLAG_STATE', 'payer is already shadow-ready');
    }
    if (!TOKEN.test(signed.monitoringOwner)) {
      throw new RcmShadowError('FLAG_SIGNED', 'a monitoring owner is required');
    }
    if (signed.rollbackTarget !== 'shadow') {
      throw new RcmShadowError('FLAG_SIGNED', 'rollback target must be shadow');
    }
    const computedMs = parseGateInstant(signed.dossier.computedAt, 'FLAG_SIGNED');
    if (computedMs > atMs || atMs - computedMs > this.maxDossierAgeHours * HOUR_MS) {
      throw new RcmShadowError(
        'FLAG_STALE',
        'dossier must be computed before, and recently before, sign-off',
      );
    }
    if (
      current.state === 'rolled-back' &&
      current.since !== null &&
      computedMs <= Date.parse(current.since)
    ) {
      throw new RcmShadowError(
        'FLAG_STALE',
        'after a rollback only a newer dossier can re-qualify',
      );
    }
    const payer = signed.dossier.payers.find((entry) => entry.payerId === signed.payerId);
    if (!payer) {
      throw new RcmShadowError('FLAG_EVIDENCE', 'dossier has no evidence for this payer');
    }
    if (payer.verdict !== 'pass') {
      throw new RcmShadowError(
        'FLAG_EVIDENCE',
        `payer gates are ${payer.verdict}; insufficient evidence blocks`,
      );
    }
    for (const gateId of GATE_IDS) {
      const gate = payer.gates.find((result) => result.gateId === gateId);
      if (gate?.verdict !== 'pass') {
        throw new RcmShadowError(
          'FLAG_EVIDENCE',
          `gate ${gateId} is ${gate?.verdict ?? 'missing'} for this payer`,
        );
      }
    }
    this.assertApprovals(signed, computedMs, atMs);
    this.transition(
      current,
      'shadow-ready',
      'shadow-ready',
      'signed promotion record',
      signed.monitoringOwner,
      signed.at,
    );
    current.monitoringOwner = signed.monitoringOwner;
    return current.state;
  }

  public rollback(
    tenantId: string,
    payerId: string,
    reason: string,
    actor: string,
    at: string,
  ): PayerFlagState {
    this.advance(at);
    const current = this.record(tenantId, payerId);
    if (current.state !== 'shadow-ready') {
      throw new RcmShadowError('FLAG_STATE', `a ${current.state} payer has nothing to roll back`);
    }
    this.assertAudit(actor, reason);
    this.transition(current, 'rolled-back', 'rollback', reason, actor, at);
    return current.state;
  }

  /** Rolls back every shadow-ready payer of one tenant at once. Returns the payers it rolled back. */
  public killSwitch(
    tenantId: string,
    reason: string,
    actor: string,
    at: string,
  ): readonly string[] {
    this.advance(at);
    this.assertAudit(actor, reason);
    const rolled: string[] = [];
    for (const current of this.tenantRecords(tenantId)) {
      if (current.state === 'shadow-ready') {
        this.transition(current, 'rolled-back', 'kill-switch', reason, actor, at);
        rolled.push(current.payerId);
      }
    }
    return rolled;
  }

  /**
   * Monitoring pass for the dossier's tenant: any shadow-ready payer whose fresh dossier no longer
   * passes is rolled back automatically. Returns the payers rolled back.
   */
  public monitor(dossier: PromotionDossier): readonly string[] {
    if (!isIssuedDossier(dossier)) {
      throw new RcmShadowError(
        'FLAG_DOSSIER',
        'dossier was not issued by evaluatePromotion or was altered',
      );
    }
    const at = dossier.computedAt;
    this.advance(at);
    const rolled: string[] = [];
    for (const current of this.tenantRecords(dossier.tenantId)) {
      if (current.state !== 'shadow-ready') {
        continue;
      }
      const payer = dossier.payers.find((entry) => entry.payerId === current.payerId);
      const verdict = payer?.verdict ?? 'insufficient';
      if (verdict !== 'pass') {
        this.transition(
          current,
          'rolled-back',
          'monitor-rollback',
          `monitor verdict ${verdict}`,
          dossier.computedBy,
          at,
        );
        rolled.push(current.payerId);
      }
    }
    return rolled;
  }

  /** The harness cannot make a payer live. This guard exists so a caller finds that out loudly. */
  public promoteLive(payerId: string): never {
    throw new RcmShadowError(
      'FLAG_CEILING',
      `${payerId}: the WP-092 ceiling is shadow-ready; live promotion is not available`,
    );
  }

  public log(tenantId?: string): readonly FlagEvent[] {
    return Object.freeze(
      tenantId === undefined
        ? [...this.events]
        : this.events.filter((event) => event.tenantId === tenantId),
    );
  }

  private assertApprovals(signed: SignedPromotion, computedMs: number, atMs: number): void {
    const seen = new Set<ApproverRole>();
    const approvers = new Set<string>();
    for (const approval of signed.approvals) {
      if (!REQUIRED_APPROVER_ROLES.includes(approval.role) || seen.has(approval.role)) {
        throw new RcmShadowError('FLAG_APPROVAL', 'one approval per required role');
      }
      seen.add(approval.role);
      if (!TOKEN.test(approval.approverId)) {
        throw new RcmShadowError('FLAG_APPROVAL', 'approverId must be a token');
      }
      // Separation of duties: four roles means four different people, compared canonically.
      const approver = canonicalApproverId(approval.approverId);
      if (approvers.has(approver)) {
        throw new RcmShadowError(
          'FLAG_SEPARATION',
          `${approval.approverId} already approved under another role`,
        );
      }
      approvers.add(approver);
      if (approver === canonicalApproverId(signed.dossier.computedBy)) {
        throw new RcmShadowError(
          'FLAG_SELF_PROMOTION',
          'the dossier author cannot approve its own promotion',
        );
      }
      const approvedMs = parseGateInstant(approval.at, 'FLAG_APPROVAL');
      if (approvedMs < computedMs || approvedMs > atMs) {
        throw new RcmShadowError(
          'FLAG_APPROVAL',
          'approval must fall between the dossier and the sign-off',
        );
      }
      if (approval.decision !== 'approve') {
        throw new RcmShadowError('FLAG_APPROVAL', `${approval.role} decided ${approval.decision}`);
      }
    }
    const missing = REQUIRED_APPROVER_ROLES.filter((role) => !seen.has(role));
    if (missing.length > 0) {
      throw new RcmShadowError('FLAG_APPROVAL', `missing approval from ${missing.join(', ')}`);
    }
  }

  private assertAudit(actor: string, reason: string): void {
    if (!TOKEN.test(actor) || reason.length === 0) {
      throw new RcmShadowError('FLAG_AUDIT', 'a flag change needs an actor token and a reason');
    }
  }

  /** Checks order only; the clock moves when a transition is actually recorded. */
  private advance(at: string): number {
    const atMs = parseGateInstant(at, 'FLAG_AT');
    if (atMs < this.lastAtMs) {
      throw new RcmShadowError('FLAG_ORDER', 'flag changes must not go back in time');
    }
    return atMs;
  }

  private tenantRecords(tenantId: string): readonly FlagRecord[] {
    return [...this.flags.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((left, right) => left.payerId.localeCompare(right.payerId));
  }

  private record(tenantId: string, payerId: string): FlagRecord {
    if (!TOKEN.test(tenantId) || !TOKEN.test(payerId)) {
      throw new RcmShadowError('FLAG_PAYER', 'tenantId and payerId must be tokens');
    }
    const key = flagKey(tenantId, payerId);
    let record = this.flags.get(key);
    if (!record) {
      record = { tenantId, payerId, state: 'shadow', since: null, monitoringOwner: null };
      this.flags.set(key, record);
    }
    return record;
  }

  private transition(
    record: FlagRecord,
    to: PayerFlagState,
    kind: FlagEventKind,
    reason: string,
    actor: string,
    at: string,
  ): void {
    this.events.push(
      Object.freeze({
        tenantId: record.tenantId,
        payerId: record.payerId,
        kind,
        from: record.state,
        to,
        actor,
        reason,
        at,
      }),
    );
    record.state = to;
    record.since = at;
    this.lastAtMs = Date.parse(at);
  }
}
