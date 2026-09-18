import { hashRecord, sha256 } from './hash.js';
import { assertSimulatedCeiling, type DraftingFlags } from './flags.js';
import type { EvalGatePort, ThreadDraftPort } from './ports.js';
import type {
  DraftArtifact,
  DraftBinding,
  DraftKind,
  ProvenanceRecord,
  QueueDecision,
} from './types.js';
import { DraftingRefusal } from './types.js';

const disclosure = 'written by the named reviewer with support of automated tools; synthetic only';

export interface DraftingPorts {
  readonly evalGate: EvalGatePort;
  readonly thread: ThreadDraftPort;
  readonly flags: DraftingFlags;
  readonly now: () => string;
}

export function renderProvenance(record: ProvenanceRecord): string {
  if (record.disclosureString.trim() === '' || record.sourceRefs.length === 0) {
    throw new DraftingRefusal('provenance cannot render without disclosure and sources');
  }
  const reviewer = record.reviewerRef ?? 'unreviewed';
  return `${record.disclosureString} | producer=${record.producerRef} model=${record.modelRef}@${record.modelVersion} prompt=${record.promptVersion} reviewer=${reviewer} evidence=${record.evidenceHash}`;
}

function provenanceFor(
  binding: DraftBinding,
  body: string,
  sourceRefs: readonly string[],
): ProvenanceRecord {
  const evidenceHash = hashRecord({ binding, body, sourceRefs });
  return {
    producerRef: 'ai-drafting/wp-102',
    modelRef: binding.modelRef,
    modelVersion: binding.modelVersion,
    promptVersion: binding.promptVersion,
    sourceRefs,
    confidence: 0.8,
    disclosureString: disclosure,
    reviewerRef: null,
    reviewerAction: null,
    reviewedAt: null,
    evidenceHash,
    synthetic: true,
  };
}

export function draftArtifact(
  ports: DraftingPorts,
  input: {
    readonly draftId: string;
    readonly kind: DraftKind;
    readonly binding: DraftBinding;
    readonly body: string;
    readonly sourceRefs: readonly string[];
    readonly requiredMetricRed?: boolean;
  },
): DraftArtifact {
  assertSimulatedCeiling(ports.flags);
  if (!ports.flags.draftingSurfacesEnabled) {
    throw new DraftingRefusal('drafting surfaces are flagged off');
  }
  if (input.body.trim() === '' || input.sourceRefs.length === 0) {
    throw new DraftingRefusal('draft body and source refs are required');
  }
  const thread = ports.thread.readSubject({
    tenantId: input.binding.tenantId,
    threadRef: input.binding.threadRef,
  });
  if (thread === null) {
    throw new DraftingRefusal('thread double refused an unknown thread');
  }
  const mismatched = thread.subjectRef !== input.binding.subjectRef;
  const evalDecision = ports.evalGate.evaluate({
    binding: input.binding,
    body: input.body,
    ...(input.requiredMetricRed === undefined
      ? {}
      : { requiredMetricRed: input.requiredMetricRed }),
  });
  return {
    draftId: input.draftId,
    kind: input.kind,
    binding: input.binding,
    body: input.body,
    bodyHash: sha256(input.body),
    provenance: provenanceFor(input.binding, input.body, input.sourceRefs),
    state: mismatched ? 'quarantined' : 'queued',
    quarantineReason: mismatched ? 'wrong-patient-subject' : null,
    evalDecision,
    synthetic: true,
  };
}

export function decideQueue(
  ports: DraftingPorts,
  artifact: DraftArtifact,
  decision: QueueDecision,
  reviewerRef: string,
  editedBody?: string | undefined,
): DraftArtifact {
  assertSimulatedCeiling(ports.flags);
  if (artifact.state === 'quarantined') {
    throw new DraftingRefusal('quarantined drafts cannot leave the queue by ordinary approval');
  }
  if (artifact.state !== 'queued') {
    throw new DraftingRefusal('only queued drafts accept a review decision');
  }
  if (decision === 'approve' && artifact.evalDecision === 'promotion-blocked') {
    throw new DraftingRefusal('a red required eval metric blocks send');
  }
  if (decision === 'edit') {
    const body = editedBody ?? artifact.body;
    if (body.trim() === '') {
      throw new DraftingRefusal('edited body is required');
    }
    return {
      ...artifact,
      body,
      bodyHash: sha256(body),
      state: 'queued',
      provenance: {
        ...artifact.provenance,
        reviewerRef,
        reviewerAction: 'edit',
        reviewedAt: ports.now(),
      },
    };
  }
  const reviewed: DraftArtifact = {
    ...artifact,
    state: decision === 'approve' ? 'approved' : 'rejected',
    provenance: {
      ...artifact.provenance,
      reviewerRef,
      reviewerAction: decision,
      reviewedAt: ports.now(),
    },
  };
  if (decision !== 'approve') {
    return reviewed;
  }
  const send = ports.thread.enqueueOutbound({
    tenantId: artifact.binding.tenantId,
    threadRef: artifact.binding.threadRef,
    subjectRef: artifact.binding.subjectRef,
    bodyHash: artifact.bodyHash,
    disclosureString: artifact.provenance.disclosureString,
  });
  if (send !== 'accepted') {
    throw new DraftingRefusal('thread double refused outbound enqueue');
  }
  return { ...reviewed, state: 'sent' };
}

export function autoSend(artifact: DraftArtifact): never {
  void artifact;
  throw new DraftingRefusal('AI drafts never auto-send');
}

export function restoreQuarantine(
  artifact: DraftArtifact,
  correctSubjectRef: string,
): DraftArtifact {
  if (artifact.state !== 'quarantined') {
    throw new DraftingRefusal('restore applies only to quarantined drafts');
  }
  if (correctSubjectRef !== artifact.binding.subjectRef) {
    throw new DraftingRefusal('restore subject must match the draft binding');
  }
  return { ...artifact, state: 'queued', quarantineReason: null };
}
