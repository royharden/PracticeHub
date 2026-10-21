import { RcmShadowError } from '../contracts.js';

import type { Wp086ClaimCodingPort, Wp086ClaimLine } from './claim-placeholder.js';
import type {
  CodingGatewayDecision,
  CodingGatewayPort,
  CodingKillSwitchPort,
} from './gateway-port.js';
import { mintReviewedCode, revokeReviewedCode } from './review-mint.js';
import type { ReviewerDirectoryPort } from './reviewer-directory.js';
import {
  CODING_SUGGESTION_USE_CASE,
  type CodeSuggestion,
  type CodeSystem,
  type HumanReviewer,
  type ManualCodeEntry,
  type ManualReason,
  type ReviewedCode,
  type ReviewedOrigin,
  type ReviewerAction,
  type SuggestionProvenance,
  type WorklistEvent,
  type WorklistItem,
  type WorklistItemInput,
} from './types.js';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_SUGGESTIONS = 25;

const CODE_PATTERNS: Readonly<Record<CodeSystem, RegExp>> = {
  CPT: /^\d{4}[0-9A-Z]$/,
  HCPCS: /^[A-V]\d{4}$/,
  'ICD-10-CM': /^[A-TV-Z]\d[0-9A-Z](\.[0-9A-Z]{1,4})?$/,
};

function fail(code: string, message: string): never {
  throw new RcmShadowError(code, message);
}

function assertCode(system: CodeSystem, code: string, units: number): void {
  const pattern = CODE_PATTERNS[system] as RegExp | undefined;
  if (pattern === undefined || !pattern.test(code)) {
    fail('CODING_CODE', `code ${code} is not a valid ${system} code`);
  }
  if (!Number.isSafeInteger(units) || units < 1 || units > 999) {
    fail('CODING_UNITS', 'units must be an integer from 1 to 999');
  }
  if (system === 'ICD-10-CM' && units !== 1) {
    fail('CODING_UNITS', 'diagnosis codes carry exactly one unit');
  }
}

function isSystem(value: unknown): value is CodeSystem {
  return value === 'CPT' || value === 'HCPCS' || value === 'ICD-10-CM';
}

interface ParsedSuggestion {
  readonly system: CodeSystem;
  readonly code: string;
  readonly units: number;
  readonly rationale: string;
  readonly confidence: number;
}

/** Strict parse of model output. Any defect rejects the whole output; nothing partial is kept. */
function parseOutput(body: string): readonly ParsedSuggestion[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || !('suggestions' in raw)) {
    return null;
  }
  const list = (raw as { suggestions: unknown }).suggestions;
  if (!Array.isArray(list) || list.length > MAX_SUGGESTIONS) {
    return null;
  }
  const parsed: ParsedSuggestion[] = [];
  for (const entry of list as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const s = entry as Record<string, unknown>;
    const { system, code, units, rationale, confidence } = s;
    if (
      !isSystem(system) ||
      typeof code !== 'string' ||
      typeof units !== 'number' ||
      typeof rationale !== 'string' ||
      rationale.length === 0 ||
      rationale.length > 500 ||
      typeof confidence !== 'number' ||
      !(confidence >= 0 && confidence <= 1)
    ) {
      return null;
    }
    try {
      assertCode(system, code, units);
    } catch {
      return null;
    }
    parsed.push({ system, code, units, rationale, confidence });
  }
  return parsed;
}

interface MutableItem {
  readonly input: WorklistItemInput;
  state: WorklistItem['state'];
  suggestions: readonly CodeSuggestion[];
  manualReason: ManualReason | null;
  reviewed: readonly ReviewedCode[];
  attempts: number;
  /** Attempt number of the gateway call in flight, or null. At most one per item. */
  inFlight: number | null;
  /** Every actor that enqueued, requested suggestions for, or attached this item. */
  readonly actors: Set<string>;
}

export interface SuggestionRequestContext {
  /** The service actor that asks the gateway; never a reviewer. */
  readonly actorRef: string;
  readonly at: string;
}

/**
 * The coding worklist. Items move queued -> awaiting-review | manual -> reviewed -> attached.
 * Suggestions are inert data: only `review`, given a human reviewer resolved through the reviewer
 * directory, produces codes, and only reviewed codes can be attached to a claim. Engaging the kill
 * switch quarantines AI output that has not reached a claim.
 */
export class CodingWorklist {
  private readonly items = new Map<string, MutableItem>();
  private readonly log: WorklistEvent[] = [];
  private reviewSeq = 0;

  public constructor(
    private readonly gateway: CodingGatewayPort,
    private readonly killSwitch: CodingKillSwitchPort,
    private readonly reviewers: ReviewerDirectoryPort,
  ) {}

  public enqueue(input: WorklistItemInput, at: string, actorRef: string): WorklistItem {
    for (const [field, value] of [
      ['itemId', input.itemId],
      ['tenantId', input.tenantId],
      ['encounterId', input.encounterId],
      ['claimId', input.claimId],
      ['documentationRef', input.documentationRef],
      ['actorRef', actorRef],
    ] as const) {
      if (!TOKEN.test(value)) fail('CODING_INPUT', `${field} must be a token`);
    }
    if (!HASH.test(input.documentationHash))
      fail('CODING_INPUT', 'documentationHash must be sha256');
    if (!DAY.test(input.serviceDate)) fail('CODING_INPUT', 'serviceDate must be YYYY-MM-DD');
    this.assertInstant(at);
    if (this.items.has(input.itemId)) fail('CODING_DUPLICATE', 'item is already on the worklist');
    const item: MutableItem = {
      input: { ...input },
      state: 'queued',
      suggestions: [],
      manualReason: null,
      reviewed: [],
      attempts: 0,
      inFlight: null,
      actors: new Set([actorRef]),
    };
    this.items.set(input.itemId, item);
    this.record(input.itemId, at, 'enqueued', actorRef, 'queued for coding');
    return this.view(item);
  }

  public async requestSuggestions(
    itemId: string,
    context: SuggestionRequestContext,
  ): Promise<WorklistItem> {
    const item = this.require(itemId);
    this.assertInstant(context.at);
    if (!TOKEN.test(context.actorRef)) fail('CODING_INPUT', 'actorRef must be a token');
    if (item.inFlight !== null) {
      fail('CODING_IN_FLIGHT', `a suggestion request for ${itemId} is already in flight`);
    }
    if (item.state !== 'queued' && item.state !== 'manual') {
      fail('CODING_STATE', `suggestions cannot be requested in state ${item.state}`);
    }
    item.actors.add(context.actorRef);
    const { tenantId } = item.input;
    if (this.killed(tenantId)) {
      return this.toManual(item, 'kill-switch', context);
    }
    item.attempts += 1;
    const attempt = item.attempts;
    item.inFlight = attempt;
    try {
      const outcome = await this.callGateway(item, attempt, context);
      // Compare-and-set: the item may have been reviewed, attached or retried while we waited.
      if (item.inFlight !== attempt || (item.state !== 'queued' && item.state !== 'manual')) {
        this.record(
          itemId,
          context.at,
          'late-result-discarded',
          context.actorRef,
          `attempt ${String(attempt)} answered after the item moved to ${item.state}`,
        );
        return this.view(item);
      }
      if (this.killed(tenantId)) return this.toManual(item, 'kill-switch', context);
      if (outcome.kind === 'manual') return this.toManual(item, outcome.reason, context);

      item.suggestions = outcome.parsed.map((s, index) =>
        Object.freeze({
          suggestionId: `${itemId}:A${String(attempt)}:S${String(index + 1)}`,
          itemId,
          ...s,
          provenance: outcome.provenance,
        }),
      );
      item.state = 'awaiting-review';
      item.manualReason = null;
      this.record(
        itemId,
        context.at,
        'suggestions-received',
        context.actorRef,
        `${String(outcome.parsed.length)} suggestions from ${outcome.provenance.interactionRef}`,
      );
      return this.view(item);
    } finally {
      if (item.inFlight === attempt) item.inFlight = null;
    }
  }

  /** The only path from a suggestion to a claim-ready code. */
  public review(itemId: string, action: ReviewerAction): readonly ReviewedCode[] {
    const item = this.require(itemId);
    this.assertInstant(action.reviewedAt);
    if (this.quarantineIfKilled(item, action.reviewedAt, 'kill-switch')) {
      fail(
        'CODING_KILL_SWITCH',
        'the kill switch is engaged: AI suggestions were withdrawn; code manually',
      );
    }
    if (item.state !== 'awaiting-review' && item.state !== 'manual') {
      fail('CODING_STATE', `review is not open in state ${item.state}`);
    }
    const reviewer = this.resolveReviewer(item, action.reviewerSessionRef);

    const open = new Map(item.suggestions.map((s) => [s.suggestionId, s]));
    const decided = new Set<string>();
    for (const decision of action.decisions) {
      if (!open.has(decision.suggestionId)) {
        fail('CODING_DECISION', `unknown suggestion ${decision.suggestionId}`);
      }
      if (decided.has(decision.suggestionId)) {
        fail('CODING_DECISION', `duplicate decision for ${decision.suggestionId}`);
      }
      decided.add(decision.suggestionId);
    }
    if (decided.size !== open.size) {
      fail('CODING_DECISION', 'every suggestion needs an explicit reviewer decision');
    }
    // Validate the whole action before minting anything, so a refused review mints nothing.
    for (const decision of action.decisions) {
      if (decision.action === 'modify') {
        assertCode(decision.system, decision.code, decision.units);
        if (decision.reason.length === 0) fail('CODING_DECISION', 'a modification needs a reason');
      } else if (decision.action === 'reject' && decision.reason.length === 0) {
        fail('CODING_DECISION', 'a rejection needs a reason');
      }
    }
    for (const entry of action.manualCodes) this.assertManual(entry);

    this.reviewSeq += 1;
    const reviewTag = `V${String(this.reviewSeq)}`;
    const out: ReviewedCode[] = [];
    const mint = (
      system: CodeSystem,
      code: string,
      units: number,
      origin: ReviewedOrigin,
    ): void => {
      out.push(
        mintReviewedCode({
          reviewedCodeId: `${itemId}:${reviewTag}:R${String(out.length + 1)}`,
          itemId,
          tenantId: item.input.tenantId,
          claimId: item.input.claimId,
          system,
          code,
          units,
          serviceDate: item.input.serviceDate,
          reviewerRef: reviewer.reviewerRef,
          reviewedAt: action.reviewedAt,
          origin,
        }),
      );
    };

    for (const decision of action.decisions) {
      const suggestion = open.get(decision.suggestionId);
      if (suggestion === undefined) continue;
      if (decision.action === 'accept') {
        mint(suggestion.system, suggestion.code, suggestion.units, {
          kind: 'suggestion-accepted',
          suggestionId: suggestion.suggestionId,
          provenance: suggestion.provenance,
        });
      } else if (decision.action === 'modify') {
        mint(decision.system, decision.code, decision.units, {
          kind: 'suggestion-modified',
          suggestionId: suggestion.suggestionId,
          provenance: suggestion.provenance,
          suggestedCode: suggestion.code,
          reason: decision.reason,
        });
      }
    }
    for (const entry of action.manualCodes) {
      mint(entry.system, entry.code, entry.units, { kind: 'human-entered' });
    }

    item.reviewed = out;
    item.state = 'reviewed';
    this.record(
      itemId,
      action.reviewedAt,
      'reviewed',
      reviewer.reviewerRef,
      `${String(out.length)} codes approved from ${String(open.size)} suggestions`,
    );
    return out;
  }

  public attach(
    itemId: string,
    claims: Wp086ClaimCodingPort,
    at: string,
    actorRef: string,
  ): readonly Wp086ClaimLine[] {
    const item = this.require(itemId);
    this.assertInstant(at);
    if (!TOKEN.test(actorRef)) fail('CODING_INPUT', 'actorRef must be a token');
    if (this.quarantineIfKilled(item, at, actorRef)) {
      fail(
        'CODING_KILL_SWITCH',
        'the kill switch is engaged: AI-origin codes were withdrawn; code manually',
      );
    }
    if (item.state !== 'reviewed') {
      fail('CODING_NOT_REVIEWED', `item must be reviewed before attach (state ${item.state})`);
    }
    const lines = item.reviewed.map((code) => claims.attachReviewedCode(code));
    item.state = 'attached';
    item.actors.add(actorRef);
    this.record(itemId, at, 'attached', actorRef, `${String(lines.length)} lines attached`);
    return lines;
  }

  /**
   * Applies the kill switch to every open item of a tenant: AI suggestions awaiting review, and
   * reviewed codes of AI origin not yet on a claim, are withdrawn and the item goes back to manual.
   * Returns the ids of the items it moved.
   */
  public quarantine(tenantId: string, at: string, actorRef: string): readonly string[] {
    this.assertInstant(at);
    const moved: string[] = [];
    for (const item of this.items.values()) {
      if (item.input.tenantId === tenantId && this.quarantineIfKilled(item, at, actorRef)) {
        moved.push(item.input.itemId);
      }
    }
    return moved;
  }

  public item(itemId: string): WorklistItem {
    return this.view(this.require(itemId));
  }

  /** Items a human must act on, oldest first. */
  public queue(tenantId: string): readonly WorklistItem[] {
    return [...this.items.values()]
      .filter(
        (item) =>
          item.input.tenantId === tenantId &&
          (item.state === 'awaiting-review' || item.state === 'manual'),
      )
      .map((item) => this.view(item));
  }

  public events(itemId?: string): readonly WorklistEvent[] {
    return itemId === undefined ? [...this.log] : this.log.filter((e) => e.itemId === itemId);
  }

  private async callGateway(
    item: MutableItem,
    attempt: number,
    context: SuggestionRequestContext,
  ): Promise<
    | { readonly kind: 'manual'; readonly reason: ManualReason }
    | {
        readonly kind: 'suggest';
        readonly parsed: readonly ParsedSuggestion[];
        readonly provenance: SuggestionProvenance;
      }
  > {
    const { tenantId } = item.input;
    const interactionRef = `coding:${item.input.itemId}:${String(attempt)}`;
    let decision: CodingGatewayDecision;
    try {
      decision = await this.gateway.invoke({
        tenantId,
        subjectRef: item.input.encounterId,
        useCase: CODING_SUGGESTION_USE_CASE,
        actorRef: context.actorRef,
        purpose: 'coding-suggestion-for-human-review',
        interactionRef,
        idempotencyKey: interactionRef,
        occurredAt: context.at,
        mode: 'dev',
        contentRefs: [
          { bodyRef: item.input.documentationRef, bodyHash: item.input.documentationHash },
        ],
        synthetic: true,
      });
    } catch {
      return { kind: 'manual', reason: 'blocked' };
    }
    if (decision.kind !== 'completed') return { kind: 'manual', reason: decision.kind };
    let body: string;
    try {
      body = await this.gateway.readOutput(tenantId, decision.outputRef, decision.outputHash);
    } catch {
      return { kind: 'manual', reason: 'malformed-output' };
    }
    const parsed = parseOutput(body);
    if (parsed === null) return { kind: 'manual', reason: 'malformed-output' };
    if (parsed.length === 0) return { kind: 'manual', reason: 'no-suggestions' };
    const pin = this.gateway.pin;
    return {
      kind: 'suggest',
      parsed,
      provenance: Object.freeze({
        source: 'ai-gateway',
        useCase: CODING_SUGGESTION_USE_CASE,
        interactionRef: decision.interactionRef,
        outputRef: decision.outputRef,
        outputHash: decision.outputHash,
        modelRef: pin.modelRef,
        pinnedModelVersion: pin.pinnedModelVersion,
        promptTemplateVersion: pin.promptTemplateVersion,
        bindingVersion: pin.bindingVersion,
        grantVersion: pin.grantVersion,
        documentationRef: item.input.documentationRef,
        documentationHash: item.input.documentationHash,
        requestedAt: context.at,
        synthetic: true,
      }),
    };
  }

  /** Resolves and vets the reviewer. The caller's word about who is reviewing is never used. */
  private resolveReviewer(item: MutableItem, sessionRef: string): HumanReviewer {
    if (!TOKEN.test(sessionRef)) fail('CODING_REVIEWER', 'reviewer session must be a token');
    const principal = this.reviewers.resolve(sessionRef);
    if (principal === null) fail('CODING_REVIEWER', 'reviewer session is not authenticated');
    if (principal.kind !== 'human') {
      fail(
        'CODING_REVIEWER',
        `review requires a human reviewer; this principal is ${principal.kind}`,
      );
    }
    if (principal.tenantId !== item.input.tenantId) {
      fail('CODING_REVIEWER', 'reviewer belongs to another tenant');
    }
    const role = principal.roles.includes('coding-lead')
      ? 'coding-lead'
      : principal.roles.includes('coder')
        ? 'coder'
        : null;
    if (role === null) fail('CODING_REVIEWER', 'reviewer lacks the coder or coding-lead role');
    if (item.actors.has(principal.principalRef)) {
      fail(
        'CODING_REVIEWER',
        'the reviewer may not be an actor that queued or requested this item',
      );
    }
    if (principal.principalRef === this.gateway.pin.modelRef) {
      fail('CODING_REVIEWER', 'the model cannot review its own suggestions');
    }
    return { kind: 'human', reviewerRef: principal.principalRef, role };
  }

  /** Withdraws AI output from an item when the kill switch is engaged. True when it moved the item. */
  private quarantineIfKilled(item: MutableItem, at: string, actorRef: string): boolean {
    if (!this.killed(item.input.tenantId)) return false;
    const aiReviewed = item.reviewed.filter((code) => code.origin.kind !== 'human-entered');
    const holdsAi =
      (item.state === 'awaiting-review' && item.suggestions.length > 0) ||
      (item.state === 'reviewed' && aiReviewed.length > 0);
    if (!holdsAi) return false;
    for (const code of item.reviewed) revokeReviewedCode(code);
    item.state = 'manual';
    item.suggestions = [];
    item.reviewed = [];
    item.manualReason = 'kill-switch';
    this.record(
      item.input.itemId,
      at,
      'quarantined',
      actorRef,
      'kill switch engaged; AI output withdrawn',
    );
    return true;
  }

  private killed(tenantId: string): boolean {
    return this.killSwitch.engaged(tenantId, CODING_SUGGESTION_USE_CASE);
  }

  private toManual(
    item: MutableItem,
    reason: ManualReason,
    context: SuggestionRequestContext,
  ): WorklistItem {
    item.state = 'manual';
    item.suggestions = [];
    item.manualReason = reason;
    this.record(item.input.itemId, context.at, 'manual-fallback', context.actorRef, reason);
    return this.view(item);
  }

  private assertManual(entry: ManualCodeEntry): void {
    if (!isSystem(entry.system)) fail('CODING_CODE', 'unknown code system');
    assertCode(entry.system, entry.code, entry.units);
  }

  private assertInstant(at: string): void {
    if (!INSTANT.test(at)) fail('CODING_TIME', 'timestamps must be UTC ISO-8601');
  }

  private require(itemId: string): MutableItem {
    const item = this.items.get(itemId);
    if (item === undefined) fail('CODING_UNKNOWN_ITEM', `no worklist item ${itemId}`);
    return item;
  }

  private record(
    itemId: string,
    at: string,
    kind: WorklistEvent['kind'],
    actorRef: string,
    detail: string,
  ): void {
    this.log.push(Object.freeze({ itemId, at, kind, actorRef, detail }));
  }

  private view(item: MutableItem): WorklistItem {
    return Object.freeze({
      input: item.input,
      state: item.state,
      suggestions: [...item.suggestions],
      manualReason: item.manualReason,
      reviewed: [...item.reviewed],
    });
  }
}
