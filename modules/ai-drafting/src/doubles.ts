import {
  evalGateDoubleVersion,
  threadDraftPortVersion,
  type EvalGateInput,
  type EvalGatePort,
  type ThreadDraftPort,
} from './ports.js';

export class RecordingEvalGate implements EvalGatePort {
  public readonly interfaceVersion = evalGateDoubleVersion;
  public readonly calls: EvalGateInput[] = [];

  public evaluate(input: EvalGateInput): 'promotion-recommended' | 'promotion-blocked' {
    this.calls.push(input);
    return input.requiredMetricRed === true ? 'promotion-blocked' : 'promotion-recommended';
  }
}

export class RecordingThreadDraftPort implements ThreadDraftPort {
  public readonly interfaceVersion = threadDraftPortVersion;
  public readonly outbound: Array<Parameters<ThreadDraftPort['enqueueOutbound']>[0]> = [];
  readonly #subjects = new Map<string, string>();

  public seed(tenantId: string, threadRef: string, subjectRef: string): void {
    this.#subjects.set(`${tenantId}|${threadRef}`, subjectRef);
  }

  public readSubject(input: {
    readonly tenantId: string;
    readonly threadRef: string;
  }): { readonly subjectRef: string } | null {
    const subjectRef = this.#subjects.get(`${input.tenantId}|${input.threadRef}`);
    return subjectRef === undefined ? null : { subjectRef };
  }

  public enqueueOutbound(
    input: Parameters<ThreadDraftPort['enqueueOutbound']>[0],
  ): 'accepted' | 'refused' {
    const bound = this.readSubject(input);
    if (bound === null || bound.subjectRef !== input.subjectRef) {
      return 'refused';
    }
    this.outbound.push(input);
    return 'accepted';
  }
}
