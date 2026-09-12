import {
  injectionOutcomeClasses,
  railResponseStatuses,
  simEffectStates,
  type RailRequest,
  type RailResponse,
} from '@practicehub/vendor-sim-kit';

import type { ModelProviderPort } from './ports.js';
import type { ModelProviderResult, ProviderPrompt, ToolProposal } from './types.js';
import { sha256 } from './guards.js';

export interface ModelRailResult {
  readonly response: RailResponse;
  readonly outputBody: string;
  readonly toolProposals: readonly ToolProposal[];
}

const simRefPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const vendorVersionPattern = /^[A-Za-z0-9][A-Za-z0-9+._/-]{0,127}$/;

export function rail022IdempotencyKey(prompt: ProviderPrompt): string {
  return `ai-${sha256(
    JSON.stringify({
      tenantId: prompt.tenantId,
      subjectRef: prompt.subjectRef,
      interactionRef: prompt.interactionRef,
      callerKey: prompt.idempotencyKey,
      modelRef: prompt.control.modelRef,
      pinnedModelVersion: prompt.control.pinnedModelVersion,
      promptTemplateVersion: prompt.control.promptTemplateVersion,
    }),
  )}`;
}

function validRailResponse(value: unknown): value is RailResponse {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  const status = row['status'];
  const outcome = row['outcomeClass'];
  const effectState = row['effectState'];
  return (
    row['railId'] === 'RAIL-022' &&
    row['operation'] === 'complete' &&
    typeof status === 'string' &&
    (railResponseStatuses as readonly string[]).includes(status) &&
    typeof row['effectKey'] === 'string' &&
    simRefPattern.test(row['effectKey']) &&
    typeof row['idempotencyKey'] === 'string' &&
    simRefPattern.test(row['idempotencyKey']) &&
    (row['receiptRef'] === null ||
      (typeof row['receiptRef'] === 'string' && simRefPattern.test(row['receiptRef']))) &&
    (row['duplicateOf'] === null ||
      (typeof row['duplicateOf'] === 'string' && simRefPattern.test(row['duplicateOf']))) &&
    typeof row['requiresReconciliation'] === 'boolean' &&
    row['resendsExternalEffect'] === false &&
    (row['injectedPrimitiveId'] === null ||
      (typeof row['injectedPrimitiveId'] === 'string' &&
        /^X-\d{2}$/u.test(row['injectedPrimitiveId']))) &&
    (outcome === null ||
      (typeof outcome === 'string' &&
        (injectionOutcomeClasses as readonly string[]).includes(outcome))) &&
    typeof row['declaredDelayMs'] === 'number' &&
    Number.isInteger(row['declaredDelayMs']) &&
    row['declaredDelayMs'] >= 0 &&
    (row['retryAfterSeconds'] === null ||
      (typeof row['retryAfterSeconds'] === 'number' &&
        Number.isInteger(row['retryAfterSeconds']) &&
        row['retryAfterSeconds'] >= 0)) &&
    typeof row['vendorVersion'] === 'string' &&
    vendorVersionPattern.test(row['vendorVersion']) &&
    typeof row['attempts'] === 'number' &&
    Number.isInteger(row['attempts']) &&
    row['attempts'] >= 1 &&
    typeof effectState === 'string' &&
    (simEffectStates as readonly string[]).includes(effectState) &&
    row['synthetic'] === true &&
    (status !== 'uncertain' || row['requiresReconciliation'] === true)
  );
}

/** Transport is supplied by integration; the gateway never invents simulator HTTP paths. */
export interface Rail022Transport {
  dispatch(request: RailRequest): Promise<ModelRailResult>;
}

export interface ProviderRequestFence {
  claim(input: {
    readonly tenantId: string;
    readonly outboundIdempotencyKey: string;
    readonly promptHash: string;
    readonly interactionRef: string;
  }): Promise<'new' | 'same' | 'conflict'>;
}

export class InMemoryProviderRequestFence implements ProviderRequestFence {
  readonly #claims = new Map<string, string>();

  public async claim(input: Parameters<ProviderRequestFence['claim']>[0]) {
    const key = `${input.tenantId}|${input.outboundIdempotencyKey}`;
    const existing = this.#claims.get(key);
    if (existing === undefined) {
      this.#claims.set(key, input.promptHash);
      return 'new' as const;
    }
    return existing === input.promptHash ? ('same' as const) : ('conflict' as const);
  }
}

type FetchLike = (
  input: string,
  init: {
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

/** Local-only HTTP binding for the frozen simulator route. */
export class LocalRail022HttpTransport implements Rail022Transport {
  readonly #baseUrl: string;

  public constructor(
    baseUrl: string,
    private readonly fetcher: FetchLike = fetch,
  ) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      throw new Error('RAIL-022 dev transport must use an injected loopback HTTP base URL');
    }
    this.#baseUrl = url.toString().replace(/\/$/u, '');
  }

  public async dispatch(request: RailRequest): Promise<ModelRailResult> {
    const response = await this.fetcher(`${this.#baseUrl}/rails/RAIL-022/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`RAIL-022 simulator refused request (${response.status})`);
    const decoded = (await response.json()) as Record<string, unknown>;
    if (decoded['synthetic'] !== true || !validRailResponse(decoded['response'])) {
      throw new Error('RAIL-022 response envelope is malformed or contradictory');
    }
    const railResponse = decoded['response'];
    return {
      response: railResponse,
      outputBody: JSON.stringify({
        candidate: true,
        receiptRef: railResponse.receiptRef,
        vendorVersion: railResponse.vendorVersion,
        synthetic: true,
      }),
      toolProposals: [],
    };
  }
}

/** Concrete dev-provider adapter over the frozen RAIL-022 request/response contract. */
export class Rail022DevProvider implements ModelProviderPort {
  public constructor(
    private readonly transport: Rail022Transport,
    private readonly fence: ProviderRequestFence,
  ) {}

  public async complete(prompt: ProviderPrompt): Promise<ModelProviderResult> {
    const outboundIdempotencyKey = rail022IdempotencyKey(prompt);
    const promptHash = sha256(JSON.stringify(prompt));
    const claim = await this.fence.claim({
      tenantId: prompt.tenantId,
      outboundIdempotencyKey,
      promptHash,
      interactionRef: prompt.interactionRef,
    });
    if (claim === 'conflict') {
      throw new Error('RAIL-022 idempotency key was reused with a different prompt hash');
    }
    const result = await this.transport.dispatch({
      railId: 'RAIL-022',
      operation: 'complete',
      idempotencyKey: outboundIdempotencyKey,
      payloadRef: prompt.interactionRef,
      requestedAt: prompt.occurredAt,
      payload: {
        synthetic: true,
        promptRef: prompt.interactionRef,
        promptHash,
      },
      synthetic: true,
    });
    const response = result.response;
    if (
      response.railId !== 'RAIL-022' ||
      response.operation !== 'complete' ||
      response.idempotencyKey !== outboundIdempotencyKey ||
      response.synthetic !== true ||
      !validRailResponse(response)
    ) {
      return {
        status: 'malformed',
        receiptRef: null,
        actualModelVersion: response.vendorVersion,
        outputBody: '',
        toolProposals: [],
        requiresReconciliation: true,
        resendsExternalEffect: false,
        synthetic: true,
      };
    }
    const status =
      response.status === 'accepted' ||
      response.status === 'deduplicated' ||
      response.status === 'uncertain' ||
      response.status === 'rejected' ||
      response.status === 'malformed'
        ? response.status
        : 'rejected';
    return {
      status,
      receiptRef: response.receiptRef,
      actualModelVersion: response.vendorVersion,
      outputBody: result.outputBody,
      toolProposals: result.toolProposals,
      requiresReconciliation: response.requiresReconciliation,
      resendsExternalEffect: response.resendsExternalEffect,
      synthetic: true,
    };
  }
}
