/**
 * Audit-evidence store domain (WP-020, M04). Contract:
 * docs/contracts/audit-emit.md (FROZEN). Architecture: ADR-008.
 *
 * One append-only store, eight streams; hash chain per tenant-day for tamper
 * evidence (R6-REQ-001); AI prompts/outputs as ref + hash pairs with model +
 * version (R6-REQ-102); payloads are REFERENCES and HASHES only — raw PHI
 * values are structurally refused at emit and have no field to land in.
 *
 * Everything here is pure over caller-supplied state: the emitter threads an
 * explicit chain state and an explicit `occurredAt`, so tests are
 * deterministic and the database rows are exactly reproducible. `audit.emit`
 * is never capability-gated (contract decision 2) — the store must be able to
 * record a DENY.
 */

import { createHash } from 'node:crypto';

import type { AuthorityDecision } from '@practicehub/platform-core';

export const auditStreams = [
  'access',
  'disclosure',
  'break-glass',
  'ai-interaction',
  'config-change',
  'consent-event',
  'authority-decision',
  'capability-transition',
] as const;
export type AuditStream = (typeof auditStreams)[number];

export const auditReasons = [
  'treatment',
  'payment',
  'operations',
  'patient-request',
  'break-glass-emergency',
  'investigation',
  'legal-obligation',
  'system-maintenance',
] as const;
export type AuditReason = (typeof auditReasons)[number];

export const auditPartitionTags = ['gipa-genetic', 'chd', 'biometric', 'part2'] as const;
export type AuditPartitionTag = (typeof auditPartitionTags)[number];

export type AuditDecision = 'allow' | 'deny';

/**
 * Reference grammar: lower-case identifiers, hashes, and refs — no spaces, no
 * upper case, so prose (and with it raw PHI values) is refused by shape.
 */
const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
// Whole-second UTC instants only: the hashed literal must reproduce exactly
// from a timestamptz round-trip (the DB suite re-derives it via to_char).
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export const genesisHash = 'genesis';

export class AuditEmitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AuditEmitError';
  }
}

export interface AuditEmitInput {
  readonly auditId: string;
  readonly tenantId: string;
  readonly stream: AuditStream;
  readonly action: string;
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly subjectRef?: string;
  readonly decision?: AuditDecision;
  readonly reason?: AuditReason;
  readonly sourceRef?: string;
  readonly correlationRef?: string;
  readonly recipientRef?: string;
  readonly purpose?: string;
  readonly modelRef?: string;
  readonly modelVersion?: string;
  readonly promptRef?: string;
  readonly promptHash?: string;
  readonly outputRef?: string;
  readonly outputHash?: string;
  readonly detail?: Readonly<Record<string, string>>;
  readonly partitionTags?: readonly AuditPartitionTag[];
  readonly synthetic: true;
}

export interface AuditRecord extends AuditEmitInput {
  readonly chainDay: string;
  readonly chainSeq: number;
  readonly prevHash: string;
  readonly entryHash: string;
}

/** Chain heads keyed by `${tenantId}|${chainDay}`. */
export type AuditChainState = ReadonlyMap<string, { readonly seq: number; readonly head: string }>;

export const emptyChainState: AuditChainState = new Map();

export function chainKeyFor(tenantId: string, chainDay: string): string {
  return `${tenantId}|${chainDay}`;
}

function assertRef(value: string, label: string): void {
  if (!refPattern.test(value)) {
    throw new AuditEmitError(
      `${label} must be a reference (lower-case ref grammar, never prose or raw values); ` +
        `received ${JSON.stringify(value)}`,
    );
  }
}

function assertOptionalRef(value: string | undefined, label: string): void {
  if (value !== undefined) {
    assertRef(value, label);
  }
}

function requireField(
  input: AuditEmitInput,
  field: keyof AuditEmitInput,
  streamLabel: string,
): void {
  if (input[field] === undefined) {
    throw new AuditEmitError(`${streamLabel} audit records require ${String(field)}`);
  }
}

function requireDetail(input: AuditEmitInput, key: string, streamLabel: string): void {
  if (input.detail?.[key] === undefined) {
    throw new AuditEmitError(`${streamLabel} audit records require detail.${key}`);
  }
}

/** Per-stream completeness rules (contract table; DB CHECKs mirror). */
function validateStreamFields(input: AuditEmitInput): void {
  switch (input.stream) {
    case 'access':
      requireField(input, 'subjectRef', 'access');
      requireField(input, 'decision', 'access');
      requireField(input, 'reason', 'access');
      break;
    case 'disclosure':
      requireField(input, 'decision', 'disclosure');
      requireField(input, 'recipientRef', 'disclosure');
      requireField(input, 'purpose', 'disclosure');
      break;
    case 'break-glass':
      requireField(input, 'subjectRef', 'break-glass');
      requireField(input, 'reason', 'break-glass');
      break;
    case 'ai-interaction':
      for (const field of [
        'subjectRef',
        'modelRef',
        'modelVersion',
        'promptRef',
        'promptHash',
        'outputRef',
        'outputHash',
      ] as const) {
        requireField(input, field, 'ai-interaction');
      }
      break;
    case 'config-change':
      requireDetail(input, 'config_ref', 'config-change');
      break;
    case 'consent-event':
      requireField(input, 'correlationRef', 'consent-event');
      break;
    case 'authority-decision':
      requireField(input, 'decision', 'authority-decision');
      requireDetail(input, 'capability_id', 'authority-decision');
      requireDetail(input, 'grant_state', 'authority-decision');
      requireDetail(input, 'checkpoint', 'authority-decision');
      break;
    case 'capability-transition':
      requireField(input, 'correlationRef', 'capability-transition');
      break;
  }
}

export function validateAuditEmitInput(input: AuditEmitInput): void {
  if (!idPattern.test(input.auditId)) {
    throw new AuditEmitError(`auditId must match ${idPattern.source}`);
  }
  if (!idPattern.test(input.tenantId)) {
    throw new AuditEmitError(`tenantId must match ${idPattern.source}`);
  }
  if (!(auditStreams as readonly string[]).includes(input.stream)) {
    throw new AuditEmitError(`unknown audit stream ${JSON.stringify(input.stream)}`);
  }
  if (!idPattern.test(input.action)) {
    throw new AuditEmitError(`action must match ${idPattern.source}`);
  }
  assertRef(input.actorRef, 'actorRef');
  if (!isoInstantPattern.test(input.occurredAt)) {
    throw new AuditEmitError(
      `occurredAt must be a whole-second UTC instant (YYYY-MM-DDTHH:MM:SSZ); ` +
        `received ${JSON.stringify(input.occurredAt)}`,
    );
  }
  if (input.synthetic !== true) {
    throw new AuditEmitError('audit records carry the synthetic watermark in this environment');
  }
  if (input.decision !== undefined && input.decision !== 'allow' && input.decision !== 'deny') {
    throw new AuditEmitError(`decision must be allow or deny`);
  }
  if (input.reason !== undefined && !(auditReasons as readonly string[]).includes(input.reason)) {
    throw new AuditEmitError(
      `reason must come from the closed vocabulary (${auditReasons.join(', ')}); ` +
        `received ${JSON.stringify(input.reason)} — free text is never audit payload`,
    );
  }
  assertOptionalRef(input.subjectRef, 'subjectRef');
  assertOptionalRef(input.sourceRef, 'sourceRef');
  assertOptionalRef(input.correlationRef, 'correlationRef');
  assertOptionalRef(input.recipientRef, 'recipientRef');
  assertOptionalRef(input.purpose, 'purpose');
  assertOptionalRef(input.modelRef, 'modelRef');
  assertOptionalRef(input.modelVersion, 'modelVersion');
  assertOptionalRef(input.promptRef, 'promptRef');
  assertOptionalRef(input.outputRef, 'outputRef');
  for (const [field, value] of [
    ['promptHash', input.promptHash],
    ['outputHash', input.outputHash],
  ] as const) {
    if (value !== undefined && !sha256Pattern.test(value)) {
      throw new AuditEmitError(`${field} must be a sha-256 hex digest`);
    }
  }
  for (const [key, value] of Object.entries(input.detail ?? {})) {
    if (!idPattern.test(key.replaceAll('_', '-'))) {
      throw new AuditEmitError(`detail key ${JSON.stringify(key)} must be a short identifier`);
    }
    assertRef(value, `detail.${key}`);
  }
  for (const tag of input.partitionTags ?? []) {
    if (!(auditPartitionTags as readonly string[]).includes(tag)) {
      throw new AuditEmitError(`unknown partition tag ${JSON.stringify(tag)}`);
    }
  }
  validateStreamFields(input);
}

/**
 * Canonical serialization of the evidentiary fields — the hashed surface.
 * Every emitted field participates, so any tamper (including detail values
 * and partition tags) breaks the chain.
 */
export function canonicalAuditPayload(
  input: AuditEmitInput,
  chainDay: string,
  chainSeq: number,
  prevHash: string,
): string {
  return JSON.stringify([
    input.tenantId,
    input.auditId,
    chainDay,
    chainSeq,
    prevHash,
    input.stream,
    input.action,
    input.actorRef,
    input.occurredAt,
    input.subjectRef ?? null,
    input.decision ?? null,
    input.reason ?? null,
    input.sourceRef ?? null,
    input.correlationRef ?? null,
    input.recipientRef ?? null,
    input.purpose ?? null,
    input.modelRef ?? null,
    input.modelVersion ?? null,
    input.promptRef ?? null,
    input.promptHash ?? null,
    input.outputRef ?? null,
    input.outputHash ?? null,
    Object.entries(input.detail ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    [...(input.partitionTags ?? [])].sort(),
  ]);
}

export function computeEntryHash(
  input: AuditEmitInput,
  chainDay: string,
  chainSeq: number,
  prevHash: string,
): string {
  return createHash('sha256')
    .update(canonicalAuditPayload(input, chainDay, chainSeq, prevHash))
    .digest('hex');
}

export function chainDayOf(occurredAt: string): string {
  return occurredAt.slice(0, 10);
}

/**
 * audit.emit — validate, link into the tenant-day hash chain, return the new
 * chain state plus the record. Validation failures throw BEFORE any state is
 * produced (fail closed — contract decision 3).
 */
export function emitAuditEvent(
  state: AuditChainState,
  input: AuditEmitInput,
): { readonly state: AuditChainState; readonly record: AuditRecord } {
  validateAuditEmitInput(input);
  const chainDay = chainDayOf(input.occurredAt);
  const key = chainKeyFor(input.tenantId, chainDay);
  const head = state.get(key);
  const chainSeq = (head?.seq ?? 0) + 1;
  const prevHash = head?.head ?? genesisHash;
  const entryHash = computeEntryHash(input, chainDay, chainSeq, prevHash);
  const record: AuditRecord = { ...input, chainDay, chainSeq, prevHash, entryHash };
  const next = new Map(state);
  next.set(key, { seq: chainSeq, head: entryHash });
  return { state: next, record };
}

export interface AuditChainBreak {
  readonly chainKey: string;
  readonly chainSeq: number;
  readonly reason: 'gap' | 'genesis-mismatch' | 'link-mismatch' | 'hash-mismatch';
}

export interface AuditChainVerification {
  readonly valid: boolean;
  readonly chains: number;
  readonly records: number;
  readonly breaks: readonly AuditChainBreak[];
}

/**
 * Recompute every link of every tenant-day chain (R6-REQ-001 tamper
 * evidence). Any edit to any hashed field, any removed or reordered row, and
 * any forged head shows up as a named break.
 */
export function verifyAuditChain(records: readonly AuditRecord[]): AuditChainVerification {
  const chains = new Map<string, AuditRecord[]>();
  for (const record of records) {
    const key = chainKeyFor(record.tenantId, record.chainDay);
    const existing = chains.get(key);
    if (existing === undefined) {
      chains.set(key, [record]);
    } else {
      existing.push(record);
    }
  }
  const breaks: AuditChainBreak[] = [];
  for (const [chainKey, chain] of [...chains.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const ordered = [...chain].sort((left, right) => left.chainSeq - right.chainSeq);
    let expectedSeq = 1;
    let expectedPrev = genesisHash;
    for (const record of ordered) {
      if (record.chainSeq !== expectedSeq) {
        breaks.push({ chainKey, chainSeq: record.chainSeq, reason: 'gap' });
        break;
      }
      if (record.chainSeq === 1 && record.prevHash !== genesisHash) {
        breaks.push({ chainKey, chainSeq: record.chainSeq, reason: 'genesis-mismatch' });
        break;
      }
      if (record.prevHash !== expectedPrev) {
        breaks.push({ chainKey, chainSeq: record.chainSeq, reason: 'link-mismatch' });
        break;
      }
      const recomputed = computeEntryHash(
        record,
        record.chainDay,
        record.chainSeq,
        record.prevHash,
      );
      if (recomputed !== record.entryHash) {
        breaks.push({ chainKey, chainSeq: record.chainSeq, reason: 'hash-mismatch' });
        break;
      }
      expectedSeq += 1;
      expectedPrev = record.entryHash;
    }
  }
  return { valid: breaks.length === 0, chains: chains.size, records: records.length, breaks };
}

/**
 * Same-commit coupling (contract decision 3). The emit input is validated
 * FIRST: an operation that cannot be audited must not run. The operation
 * result and the audit record are only observable together — a throw from
 * either side yields NOTHING (the caller's chain state is untouched). The
 * database-level crash test in the DB suite proves the same two directions
 * over a real transaction; WP-021 lifts this shape onto the outbox
 * (FWD-AUD-021-OUTBOX).
 */
export function runAuditedOperation<T>(
  state: AuditChainState,
  input: AuditEmitInput,
  operation: () => T,
): { readonly state: AuditChainState; readonly record: AuditRecord; readonly result: T } {
  validateAuditEmitInput(input);
  const result = operation();
  const emitted = emitAuditEvent(state, input);
  return { state: emitted.state, record: emitted.record, result };
}

/**
 * Map a requireCapability outcome to an emit input (FWD-AUD-015-PDP wiring
 * shape). Machine fields only — the decision's prose reason stays in the
 * source system; allow and deny map identically, so a deny can never be
 * dropped by construction.
 */
export function auditInputForAuthorityDecision(
  decision: AuthorityDecision,
  refs: {
    readonly auditId: string;
    readonly actorRef: string;
    readonly occurredAt: string;
    readonly correlationRef?: string;
  },
): AuditEmitInput {
  return {
    auditId: refs.auditId,
    tenantId: decision.tenantId,
    stream: 'authority-decision',
    action: 'capability-check',
    actorRef: refs.actorRef,
    occurredAt: refs.occurredAt,
    decision: decision.allowed ? 'allow' : 'deny',
    ...(refs.correlationRef !== undefined ? { correlationRef: refs.correlationRef } : {}),
    detail: {
      capability_id: decision.capabilityId,
      grant_state: decision.grantState,
      minimum_state: decision.minimumState,
      checkpoint: decision.checkpoint,
      ...(decision.sinceEventId !== null ? { since_event_id: decision.sinceEventId } : {}),
    },
    synthetic: true,
  };
}

export interface AuditExportRequest {
  readonly exportAuditId: string;
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly recipientRef: string;
  readonly purpose: string;
  readonly occurredAt: string;
  readonly subjectRef?: string;
  readonly streams?: readonly AuditStream[];
}

export interface AuditExportSlice {
  readonly records: readonly AuditRecord[];
  /** Chain heads for the exported records — external re-verification anchors. */
  readonly chainHeads: readonly { readonly chainKey: string; readonly head: string }[];
  /** Union of partition tags across exported records — tags SURVIVE export. */
  readonly partitionTags: readonly AuditPartitionTag[];
  /** The export is itself audited: a disclosure record with recipient + purpose. */
  readonly exportAuditInput: AuditEmitInput;
}

/**
 * Independent exportability (R6-REQ-001) + export auditing with partition-tag
 * survival (ADR-008 Decision 4).
 */
export function exportAuditSlice(
  records: readonly AuditRecord[],
  request: AuditExportRequest,
): AuditExportSlice {
  const selected = records.filter(
    (record) =>
      record.tenantId === request.tenantId &&
      (request.subjectRef === undefined || record.subjectRef === request.subjectRef) &&
      (request.streams === undefined || request.streams.includes(record.stream)),
  );
  const heads = new Map<string, AuditRecord>();
  for (const record of selected) {
    const key = chainKeyFor(record.tenantId, record.chainDay);
    const current = heads.get(key);
    if (current === undefined || record.chainSeq > current.chainSeq) {
      heads.set(key, record);
    }
  }
  const partitionTags = [
    ...new Set(selected.flatMap((record) => record.partitionTags ?? [])),
  ].sort();
  const exportAuditInput: AuditEmitInput = {
    auditId: request.exportAuditId,
    tenantId: request.tenantId,
    stream: 'disclosure',
    action: 'audit-export',
    actorRef: request.requestedBy,
    occurredAt: request.occurredAt,
    decision: 'allow',
    recipientRef: request.recipientRef,
    purpose: request.purpose,
    ...(request.subjectRef !== undefined ? { subjectRef: request.subjectRef } : {}),
    ...(partitionTags.length > 0 ? { partitionTags } : {}),
    detail: { export_record_count: String(selected.length) },
    synthetic: true,
  };
  return {
    records: selected,
    chainHeads: [...heads.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([chainKey, record]) => ({ chainKey, head: record.entryHash })),
    partitionTags,
    exportAuditInput,
  };
}

export interface AiInteractionEvidence {
  readonly auditId: string;
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly modelRef: string;
  readonly modelVersion: string;
  readonly promptRef: string;
  readonly promptHash: string;
  readonly outputRef: string;
  readonly outputHash: string;
}

/**
 * R6-REQ-102 round-trip: every AI interaction for a subject reconstructs from
 * the store alone, each row carrying model + version and the prompt/output
 * ref + hash pairs.
 */
export function reconstructAiInteractions(
  records: readonly AuditRecord[],
  tenantId: string,
  subjectRef: string,
): readonly AiInteractionEvidence[] {
  return records
    .filter(
      (record) =>
        record.tenantId === tenantId &&
        record.stream === 'ai-interaction' &&
        record.subjectRef === subjectRef,
    )
    .sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) || left.chainSeq - right.chainSeq,
    )
    .map((record) => ({
      auditId: record.auditId,
      actorRef: record.actorRef,
      occurredAt: record.occurredAt,
      // Stream validation guarantees presence; the casts restate it for types.
      modelRef: record.modelRef as string,
      modelVersion: record.modelVersion as string,
      promptRef: record.promptRef as string,
      promptHash: record.promptHash as string,
      outputRef: record.outputRef as string,
      outputHash: record.outputHash as string,
    }));
}

/** Retrievability (R6-REQ-052 slice): the retained trail queries by subject. */
export function auditTrailForSubject(
  records: readonly AuditRecord[],
  tenantId: string,
  subjectRef: string,
): readonly AuditRecord[] {
  return records
    .filter((record) => record.tenantId === tenantId && record.subjectRef === subjectRef)
    .sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) || left.chainSeq - right.chainSeq,
    );
}
