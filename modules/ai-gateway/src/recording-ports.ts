import type { EgressDecision, EgressRequest } from '@practicehub/platform-integration';

import { sha256 } from './guards.js';
import type {
  ContainmentPort,
  ContainmentRecord,
  InteractionEvidencePort,
  ObjectStorePort,
  StoredBody,
} from './ports.js';
import type { AiGatewayRequest, InteractionEvidence } from './types.js';

function bodyKey(tenantId: string, subjectRef: string, originRef: string, bodyRef: string): string {
  return `${tenantId}|${subjectRef}|${originRef}|${bodyRef}`;
}

/** Synthetic conformance double. Scope is part of the lookup key; hash equality never authorizes. */
export class RecordingObjectStore implements ObjectStorePort {
  readonly #bodies = new Map<string, StoredBody>();

  public seed(body: StoredBody): void {
    this.#bodies.set(bodyKey(body.tenantId, body.subjectRef, body.originRef, body.bodyRef), body);
  }

  public async get(ref: Parameters<ObjectStorePort['get']>[0]): Promise<StoredBody> {
    const body = this.#bodies.get(
      bodyKey(ref.tenantId, ref.subjectRef, ref.originRef, ref.bodyRef),
    );
    if (body === undefined) {
      throw new Error('object store refuses a missing or out-of-scope body ref');
    }
    return body;
  }

  public async put(input: Parameters<ObjectStorePort['put']>[0]): Promise<StoredBody> {
    const bodyHash = sha256(input.body);
    const bodyRef = `${input.tenantId}/${input.subjectRef}/ai/${bodyHash}`;
    const body: StoredBody = {
      ...input,
      bodyRef,
      bodyHash,
      trust: 'untrusted-data',
    };
    this.seed(body);
    return body;
  }
}

function containmentKey(scope: {
  readonly tenantId: string;
  readonly useCase: string;
  readonly cohortRef: string;
  readonly bindingRef: string;
}): string {
  return `${scope.tenantId}|${scope.useCase}|${scope.cohortRef}|${scope.bindingRef}`;
}

export class RecordingContainment implements ContainmentPort {
  readonly #records = new Map<string, ContainmentRecord>();

  public async current(
    scope: Parameters<ContainmentPort['current']>[0],
  ): Promise<ContainmentRecord | null> {
    return this.#records.get(containmentKey(scope)) ?? null;
  }

  public async kill(record: ContainmentRecord): Promise<void> {
    this.#records.set(containmentKey(record), record);
  }

  public records(): readonly ContainmentRecord[] {
    return [...this.#records.values()];
  }
}

export interface RecordedEvidence {
  readonly evidence: InteractionEvidence;
  readonly egressDecision?: EgressDecision;
  readonly egressEventId?: string;
  readonly egressAuditId?: string;
}

export class RecordingEvidencePort implements InteractionEvidencePort {
  readonly commits: RecordedEvidence[] = [];

  public async commit(input: Parameters<InteractionEvidencePort['commit']>[0]): Promise<void> {
    this.commits.push(input);
  }
}

export class RecordingEgressPolicy {
  readonly requests: EgressRequest[] = [];

  public constructor(private readonly decision: EgressDecision) {}

  public evaluate(request: EgressRequest): EgressDecision {
    this.requests.push(request);
    return this.decision;
  }
}

export function scopedBody(
  request: Pick<AiGatewayRequest, 'tenantId' | 'subjectRef'>,
  input: { readonly bodyRef: string; readonly originRef: string; readonly body: string },
): StoredBody {
  return {
    tenantId: request.tenantId,
    subjectRef: request.subjectRef,
    bodyRef: input.bodyRef,
    bodyHash: sha256(input.body),
    originRef: input.originRef,
    trust: 'untrusted-data',
    body: input.body,
    synthetic: true,
  };
}
