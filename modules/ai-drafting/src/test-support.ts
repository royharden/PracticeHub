import { defaultDraftingFlags } from './flags.js';
import { RecordingEvalGate, RecordingThreadDraftPort } from './doubles.js';
import type { DraftingPorts } from './drafting.js';
import type { DraftBinding } from './types.js';

export function binding(overrides: Partial<DraftBinding> = {}): DraftBinding {
  return {
    tenantId: 'northwind-synthetic',
    subjectRef: 'sg-p-0008',
    threadRef: 'thread:sg-p-0008:inbox',
    useCase: 'inbox-reply',
    modelRef: 'model-sim',
    modelVersion: 'sim-1',
    promptVersion: 'draft-v1',
    synthetic: true,
    ...overrides,
  };
}

export function ports(options?: {
  readonly subjectRef?: string;
  readonly draftingSurfacesEnabled?: boolean;
}): DraftingPorts & {
  readonly evalGate: RecordingEvalGate;
  readonly thread: RecordingThreadDraftPort;
} {
  const evalGate = new RecordingEvalGate();
  const thread = new RecordingThreadDraftPort();
  const bound = binding();
  thread.seed(bound.tenantId, bound.threadRef, options?.subjectRef ?? bound.subjectRef);
  return {
    evalGate,
    thread,
    flags: {
      ...defaultDraftingFlags,
      draftingSurfacesEnabled: options?.draftingSurfacesEnabled ?? true,
    },
    now: () => '2026-09-18T00:00:00Z',
  };
}
