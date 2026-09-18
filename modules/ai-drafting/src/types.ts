export const draftKinds = ['message', 'summary'] as const;
export type DraftKind = (typeof draftKinds)[number];

export const queueDecisions = ['approve', 'edit', 'reject'] as const;
export type QueueDecision = (typeof queueDecisions)[number];

export const draftStates = ['queued', 'approved', 'rejected', 'quarantined', 'sent'] as const;
export type DraftState = (typeof draftStates)[number];

export interface DraftBinding {
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly threadRef: string;
  readonly useCase: 'inbox-reply' | 'previsit-brief';
  readonly modelRef: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly synthetic: true;
}

export interface ProvenanceRecord {
  readonly producerRef: string;
  readonly modelRef: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly sourceRefs: readonly string[];
  readonly confidence: number;
  readonly disclosureString: string;
  readonly reviewerRef: string | null;
  readonly reviewerAction: QueueDecision | null;
  readonly reviewedAt: string | null;
  readonly evidenceHash: string;
  readonly synthetic: true;
}

export interface DraftArtifact {
  readonly draftId: string;
  readonly kind: DraftKind;
  readonly binding: DraftBinding;
  readonly body: string;
  readonly bodyHash: string;
  readonly provenance: ProvenanceRecord;
  readonly state: DraftState;
  readonly quarantineReason: string | null;
  readonly evalDecision: 'promotion-recommended' | 'promotion-blocked';
  readonly synthetic: true;
}

export class DraftingRefusal extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DraftingRefusal';
  }
}
