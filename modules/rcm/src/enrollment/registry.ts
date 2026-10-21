import { RcmShadowError } from '../contracts.js';

import {
  ENROLLMENT_TRANSACTIONS,
  PathCatalog,
  type EnrollmentTransaction,
  type PathId,
} from './paths.js';

export type EnrollmentState =
  | 'not-enrolled'
  | 'requested'
  | 'pending-payer'
  | 'enrolled'
  | 'rejected'
  | 'suspended'
  | 'terminated';

/** Allowed payer x path x transaction transitions. Anything else is refused. */
export const ENROLLMENT_TRANSITIONS: Readonly<Record<EnrollmentState, readonly EnrollmentState[]>> =
  Object.freeze({
    'not-enrolled': Object.freeze(['requested'] as const),
    requested: Object.freeze(['pending-payer', 'rejected'] as const),
    'pending-payer': Object.freeze(['enrolled', 'rejected'] as const),
    enrolled: Object.freeze(['suspended', 'terminated'] as const),
    rejected: Object.freeze(['requested'] as const),
    suspended: Object.freeze(['enrolled', 'terminated'] as const),
    terminated: Object.freeze(['requested'] as const),
  });

export type EvidenceKind =
  | 'enrollment-request'
  | 'payer-acknowledgment'
  | 'payer-approval'
  | 'test-transaction'
  | 'payer-rejection'
  | 'suspension-notice'
  | 'termination-notice'
  | 'file-delivery'
  | 'note';

/**
 * Evidence that can prove a path is live. A file-delivery event or a note is never proof
 * that a specific transaction path is live (REQ-PLAT-012 exception).
 */
export const LIVE_PROOF_KINDS: readonly EvidenceKind[] = Object.freeze([
  'payer-approval',
  'test-transaction',
]);

/** Every evidence kind the registry accepts; anything else is refused at runtime. */
export const EVIDENCE_KINDS: readonly EvidenceKind[] = Object.freeze([
  'enrollment-request',
  'payer-acknowledgment',
  'payer-approval',
  'test-transaction',
  'payer-rejection',
  'suspension-notice',
  'termination-notice',
  'file-delivery',
  'note',
]);

export interface EvidenceAttachment {
  readonly evidenceId: string;
  readonly kind: EvidenceKind;
  readonly capturedAt: string;
  readonly synthetic: true;
}

export interface EnrollmentKey {
  readonly payerId: string;
  readonly pathId: PathId;
  readonly transaction: EnrollmentTransaction;
}

export interface EnrollmentTransition {
  readonly from: EnrollmentState;
  readonly to: EnrollmentState;
  readonly at: string;
  readonly actor: string;
  readonly reason: string;
  readonly evidence: readonly EvidenceAttachment[];
}

export interface EnrollmentRecord extends EnrollmentKey {
  readonly state: EnrollmentState;
  readonly since: string | null;
  /** Newest evidence instant across the whole history, or null before any transition. */
  readonly evidenceDate: string | null;
  readonly history: readonly EnrollmentTransition[];
}

export interface TransitionRequest extends EnrollmentKey {
  readonly to: EnrollmentState;
  readonly at: string;
  readonly actor: string;
  readonly reason: string;
  readonly evidence: readonly EvidenceAttachment[];
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function parseEnrollmentInstant(value: string, code: string): number {
  if (!INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new RcmShadowError(code, 'timestamp must be YYYY-MM-DDTHH:MM:SSZ');
  }
  return Date.parse(value);
}

export function enrollmentKey(key: EnrollmentKey): string {
  return `${key.payerId}\u001f${key.pathId}\u001f${key.transaction}`;
}

function assertEvidence(evidence: readonly EvidenceAttachment[], at: number): void {
  if (evidence.length === 0) {
    throw new RcmShadowError(
      'ENROLLMENT_EVIDENCE',
      'every transition needs an evidence attachment',
    );
  }
  const seen = new Set<string>();
  for (const item of evidence) {
    if (!TOKEN.test(item.evidenceId)) {
      throw new RcmShadowError('ENROLLMENT_EVIDENCE', 'evidenceId must be a token');
    }
    if (seen.has(item.evidenceId)) {
      throw new RcmShadowError('ENROLLMENT_EVIDENCE', 'evidenceId repeats within one transition');
    }
    seen.add(item.evidenceId);
    if (item.synthetic !== true) {
      throw new RcmShadowError('ENROLLMENT_EVIDENCE', 'evidence must be synthetic');
    }
    if (!EVIDENCE_KINDS.includes(item.kind)) {
      throw new RcmShadowError('ENROLLMENT_EVIDENCE', 'unknown evidence kind');
    }
    if (parseEnrollmentInstant(item.capturedAt, 'ENROLLMENT_EVIDENCE') > at) {
      throw new RcmShadowError('ENROLLMENT_EVIDENCE', 'evidence is captured after the transition');
    }
  }
}

interface MutableRecord {
  readonly key: EnrollmentKey;
  state: EnrollmentState;
  since: string | null;
  evidenceDate: string | null;
  readonly history: EnrollmentTransition[];
}

export class EnrollmentRegistry {
  private readonly records = new Map<string, MutableRecord>();
  private readonly evidenceIds = new Set<string>();

  public constructor(private readonly catalog: PathCatalog = new PathCatalog()) {}

  public transition(request: TransitionRequest): EnrollmentRecord {
    if (!TOKEN.test(request.payerId)) {
      throw new RcmShadowError('ENROLLMENT_PAYER', 'payerId must be a token');
    }
    if (!ENROLLMENT_TRANSACTIONS.includes(request.transaction)) {
      throw new RcmShadowError('ENROLLMENT_TRANSACTION', 'unknown transaction');
    }
    if (!this.catalog.supports(request.pathId, request.transaction)) {
      throw new RcmShadowError('ENROLLMENT_UNSUPPORTED', 'path does not carry this transaction');
    }
    if (!TOKEN.test(request.actor) || request.reason.length === 0) {
      throw new RcmShadowError(
        'ENROLLMENT_AUDIT',
        'a transition needs an actor token and a reason',
      );
    }
    const at = parseEnrollmentInstant(request.at, 'ENROLLMENT_AT');
    const current = this.get(request);
    if (!ENROLLMENT_TRANSITIONS[current.state].includes(request.to)) {
      throw new RcmShadowError(
        'ENROLLMENT_TRANSITION',
        `transition ${current.state} -> ${request.to} is not allowed`,
      );
    }
    if (current.since !== null && at < Date.parse(current.since)) {
      throw new RcmShadowError('ENROLLMENT_ORDER', 'transition is older than the current state');
    }
    assertEvidence(request.evidence, at);
    for (const item of request.evidence) {
      if (this.evidenceIds.has(item.evidenceId)) {
        throw new RcmShadowError('ENROLLMENT_EVIDENCE', 'evidenceId is already attached elsewhere');
      }
    }
    if (
      request.to === 'enrolled' &&
      !request.evidence.some((item) => LIVE_PROOF_KINDS.includes(item.kind))
    ) {
      throw new RcmShadowError(
        'ENROLLMENT_PROOF',
        'enrolled needs payer-approval or test-transaction evidence',
      );
    }
    // Every check passed: only now does the key enter the registry.
    const record = this.recordFor(request);
    for (const item of request.evidence) {
      this.evidenceIds.add(item.evidenceId);
    }
    const newestEvidence = request.evidence.reduce((left, right) =>
      left.capturedAt >= right.capturedAt ? left : right,
    ).capturedAt;
    // A frozen private copy: neither the caller's objects nor returned snapshots alias it.
    record.history.push(
      Object.freeze({
        from: record.state,
        to: request.to,
        at: request.at,
        actor: request.actor,
        reason: request.reason,
        evidence: Object.freeze(
          request.evidence.map((item) =>
            Object.freeze({
              evidenceId: item.evidenceId,
              kind: item.kind,
              capturedAt: item.capturedAt,
              synthetic: item.synthetic,
            }),
          ),
        ),
      }),
    );
    record.state = request.to;
    record.since = request.at;
    if (record.evidenceDate === null || newestEvidence > record.evidenceDate) {
      record.evidenceDate = newestEvidence;
    }
    return this.snapshot(record);
  }

  public get(key: EnrollmentKey): EnrollmentRecord {
    const record = this.records.get(enrollmentKey(key));
    if (!record) {
      return { ...key, state: 'not-enrolled', since: null, evidenceDate: null, history: [] };
    }
    return this.snapshot(record);
  }

  public isEnrolled(key: EnrollmentKey): boolean {
    return this.get(key).state === 'enrolled';
  }

  /** Every recorded payer x path x transaction, sorted by payer, path, transaction. */
  public list(): readonly EnrollmentRecord[] {
    return [...this.records.values()]
      .map((record) => this.snapshot(record))
      .sort((left, right) => enrollmentKey(left).localeCompare(enrollmentKey(right)));
  }

  public pathCatalog(): PathCatalog {
    return this.catalog;
  }

  private recordFor(key: EnrollmentKey): MutableRecord {
    const id = enrollmentKey(key);
    let record = this.records.get(id);
    if (!record) {
      record = {
        key: { payerId: key.payerId, pathId: key.pathId, transaction: key.transaction },
        state: 'not-enrolled',
        since: null,
        evidenceDate: null,
        history: [],
      };
      this.records.set(id, record);
    }
    return record;
  }

  private snapshot(record: MutableRecord): EnrollmentRecord {
    return {
      ...record.key,
      state: record.state,
      since: record.since,
      evidenceDate: record.evidenceDate,
      history: [...record.history],
    };
  }
}
