import type { DraftBinding } from './types.js';

export const evalGateDoubleVersion = 'wp101-eval-gate-double/v1' as const;
export const threadDraftPortVersion = 'wp044-thread-draft-port/v1' as const;

export interface EvalGateInput {
  readonly binding: DraftBinding;
  readonly body: string;
  readonly requiredMetricRed?: boolean;
}

export interface EvalGatePort {
  readonly interfaceVersion: typeof evalGateDoubleVersion;
  evaluate(input: EvalGateInput): 'promotion-recommended' | 'promotion-blocked';
}

export interface ThreadDraftPort {
  readonly interfaceVersion: typeof threadDraftPortVersion;
  readSubject(input: {
    readonly tenantId: string;
    readonly threadRef: string;
  }): { readonly subjectRef: string } | null;
  enqueueOutbound(input: {
    readonly tenantId: string;
    readonly threadRef: string;
    readonly subjectRef: string;
    readonly bodyHash: string;
    readonly disclosureString: string;
  }): 'accepted' | 'refused';
}
