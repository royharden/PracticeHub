/**
 * WP-087 coding worklist types. AI suggests codes; a human coder reviews them (D5.1).
 * Nothing in this folder can place a code on a claim without a recorded human action.
 */

export const WP087_PACKAGE_ID = 'WP-087' as const;

/** The AI gateway use case this worklist invokes. Tool grant: suggestion only, no side effect. */
export const CODING_SUGGESTION_USE_CASE = 'rcm.coding-suggestion' as const;

export const CODING_SUGGESTION_TOOL_ID = 'rcm.coding.suggest' as const;

export type CodeSystem = 'CPT' | 'HCPCS' | 'ICD-10-CM';

export type WorklistState = 'queued' | 'awaiting-review' | 'manual' | 'reviewed' | 'attached';

/** Why the worklist fell back to human-only coding for an item. */
export type ManualReason =
  'kill-switch' | 'contained' | 'blocked' | 'stale' | 'malformed-output' | 'no-suggestions';

export interface WorklistItemInput {
  readonly itemId: string;
  readonly tenantId: string;
  readonly encounterId: string;
  readonly claimId: string;
  /** Synthetic documentation object the gateway reads in scope. Never inline text. */
  readonly documentationRef: string;
  readonly documentationHash: string;
  readonly serviceDate: string;
}

/** Everything needed to trace a suggestion back to one gateway interaction. */
export interface SuggestionProvenance {
  readonly source: 'ai-gateway';
  readonly useCase: typeof CODING_SUGGESTION_USE_CASE;
  readonly interactionRef: string;
  readonly outputRef: string;
  readonly outputHash: string;
  readonly modelRef: string;
  readonly pinnedModelVersion: string;
  readonly promptTemplateVersion: string;
  readonly bindingVersion: number;
  readonly grantVersion: number;
  readonly documentationRef: string;
  readonly documentationHash: string;
  readonly requestedAt: string;
  readonly synthetic: true;
}

export interface CodeSuggestion {
  readonly suggestionId: string;
  readonly itemId: string;
  readonly system: CodeSystem;
  readonly code: string;
  readonly units: number;
  readonly rationale: string;
  /** 0..1, as reported by the model. Informational only; never auto-accepts. */
  readonly confidence: number;
  readonly provenance: SuggestionProvenance;
}

/** A reviewer as resolved by the reviewer directory, never as claimed by the caller. */
export interface HumanReviewer {
  readonly kind: 'human';
  readonly reviewerRef: string;
  readonly role: 'coder' | 'coding-lead';
}

export type SuggestionDecision =
  | { readonly suggestionId: string; readonly action: 'accept' }
  | { readonly suggestionId: string; readonly action: 'reject'; readonly reason: string }
  | {
      readonly suggestionId: string;
      readonly action: 'modify';
      readonly system: CodeSystem;
      readonly code: string;
      readonly units: number;
      readonly reason: string;
    };

export interface ManualCodeEntry {
  readonly system: CodeSystem;
  readonly code: string;
  readonly units: number;
}

export interface ReviewerAction {
  /** Opaque authenticated session; the reviewer directory resolves who it belongs to. */
  readonly reviewerSessionRef: string;
  readonly reviewedAt: string;
  /** Exactly one decision per open suggestion. */
  readonly decisions: readonly SuggestionDecision[];
  /** Codes the human adds that the model never suggested. */
  readonly manualCodes: readonly ManualCodeEntry[];
}

/** Where a reviewed code came from. */
export type ReviewedOrigin =
  | {
      readonly kind: 'suggestion-accepted';
      readonly suggestionId: string;
      readonly provenance: SuggestionProvenance;
    }
  | {
      readonly kind: 'suggestion-modified';
      readonly suggestionId: string;
      readonly provenance: SuggestionProvenance;
      readonly suggestedCode: string;
      readonly reason: string;
    }
  | { readonly kind: 'human-entered' };

/**
 * A code a human reviewer approved. Only the worklist's review step can mint one;
 * claim ports check the mint registry, so a structurally identical object is refused.
 */
export interface ReviewedCode {
  readonly reviewedCodeId: string;
  readonly itemId: string;
  readonly tenantId: string;
  readonly claimId: string;
  readonly system: CodeSystem;
  readonly code: string;
  readonly units: number;
  readonly serviceDate: string;
  readonly reviewerRef: string;
  readonly reviewedAt: string;
  readonly origin: ReviewedOrigin;
}

export interface WorklistEvent {
  readonly itemId: string;
  readonly at: string;
  readonly kind:
    | 'enqueued'
    | 'suggestions-received'
    | 'manual-fallback'
    | 'late-result-discarded'
    | 'quarantined'
    | 'reviewed'
    | 'attached';
  readonly actorRef: string;
  readonly detail: string;
}

export interface WorklistItem {
  readonly input: WorklistItemInput;
  readonly state: WorklistState;
  readonly suggestions: readonly CodeSuggestion[];
  readonly manualReason: ManualReason | null;
  readonly reviewed: readonly ReviewedCode[];
}
