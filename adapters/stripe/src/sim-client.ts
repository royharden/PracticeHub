import { createHash } from 'node:crypto';

import { lintStripeCharge, type StripeChargeDraft } from './phi-linter.js';
import type { EgressRequest, VendorRegistryRow } from '@practicehub/platform-integration';

export interface PaymentIntentRequest {
  readonly tenantId: string;
  readonly intentId: string;
  readonly sku: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly payloadRef: string;
  readonly requestedAt: string;
}

export interface PaymentIntentResult {
  readonly status:
    | 'accepted'
    | 'deduplicated'
    | 'uncertain'
    | 'rejected'
    | 'throttled'
    | 'unauthorized'
    | 'conflict'
    | 'unavailable'
    | 'malformed'
    | 'lint-blocked';
  readonly effectKey: string | null;
  readonly receiptRef: string | null;
  readonly requiresReconciliation: boolean;
  readonly lintReason: string | null;
  readonly synthetic: true;
}

interface SimRailResponse {
  readonly railId: 'RAIL-008';
  readonly operation: 'create-payment-intent';
  readonly idempotencyKey: string;
  readonly status: Exclude<PaymentIntentResult['status'], 'lint-blocked'>;
  readonly effectKey: string;
  readonly receiptRef: string | null;
  readonly requiresReconciliation: boolean;
  readonly retryAfterSeconds: number | null;
  readonly effectState: 'unknown' | 'partial' | 'landed' | 'not-landed';
  readonly synthetic: true;
}

export interface HttpTransport {
  post(path: string, body: Readonly<Record<string, unknown>>): Promise<unknown>;
  get(path: string): Promise<unknown>;
}

export class StripeSimError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'StripeSimError';
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StripeSimError('simulator returned a malformed envelope');
  }
  return value as Record<string, unknown>;
}

const statuses: readonly SimRailResponse['status'][] = [
  'accepted',
  'deduplicated',
  'uncertain',
  'rejected',
  'throttled',
  'unauthorized',
  'conflict',
  'unavailable',
  'malformed',
];
const effectStates: readonly SimRailResponse['effectState'][] = [
  'unknown',
  'partial',
  'landed',
  'not-landed',
];

function coherent(response: Record<string, unknown>): boolean {
  const status = response['status'];
  const state = response['effectState'];
  if (status === 'accepted') return state === 'landed' || state === 'partial';
  if (status === 'deduplicated') return state === 'landed';
  if (status === 'uncertain') return state === 'unknown' || state === 'partial';
  return state === 'not-landed';
}

function parseResponse(value: unknown, expectedIdempotencyKey: string): SimRailResponse {
  const envelope = object(value);
  const response = object(envelope['response']);
  if (
    envelope['synthetic'] !== true ||
    response['synthetic'] !== true ||
    response['railId'] !== 'RAIL-008' ||
    response['operation'] !== 'create-payment-intent' ||
    response['idempotencyKey'] !== expectedIdempotencyKey ||
    !statuses.includes(response['status'] as SimRailResponse['status']) ||
    !effectStates.includes(response['effectState'] as SimRailResponse['effectState']) ||
    typeof response['effectKey'] !== 'string' ||
    response['effectKey'] === '' ||
    (response['receiptRef'] !== null && typeof response['receiptRef'] !== 'string') ||
    typeof response['requiresReconciliation'] !== 'boolean' ||
    (response['retryAfterSeconds'] !== null && typeof response['retryAfterSeconds'] !== 'number') ||
    !coherent(response) ||
    ((response['effectState'] === 'unknown' || response['effectState'] === 'partial') &&
      response['requiresReconciliation'] !== true)
  ) {
    throw new StripeSimError('simulator response failed correlation or shape validation');
  }
  return response as unknown as SimRailResponse;
}

export class StripeSimClient {
  public constructor(
    private readonly transport: HttpTransport,
    private readonly registryRow: VendorRegistryRow | null,
    private readonly egressBase: Omit<EgressRequest, 'categories' | 'phiClass'>,
  ) {}

  public async createPaymentIntent(request: PaymentIntentRequest): Promise<PaymentIntentResult> {
    const draft: StripeChargeDraft = {
      sku: request.sku,
      metadata: request.metadata,
      payloadRef: request.payloadRef,
    };
    const lint = lintStripeCharge(draft, this.registryRow, {
      ...this.egressBase,
      phiClass: 'PHI',
      categories: ['PAY'],
    });
    if (!lint.allow) {
      return {
        status: 'lint-blocked',
        effectKey: null,
        receiptRef: null,
        requiresReconciliation: false,
        lintReason: lint.detail,
        synthetic: true,
      };
    }
    const idempotencyKey = `pay-${createHash('sha256')
      .update(JSON.stringify([request.tenantId, request.intentId]))
      .digest('hex')}`;
    const raw = await this.transport.post('/rails/RAIL-008/create-payment-intent', {
      idempotencyKey,
      payloadRef: request.payloadRef,
      requestedAt: request.requestedAt,
      payload: {
        sku: request.sku,
        synthetic: true,
      },
      synthetic: true,
    });
    const response = parseResponse(raw, idempotencyKey);
    return {
      status: response.status,
      effectKey: response.effectKey,
      receiptRef: response.receiptRef,
      requiresReconciliation: response.requiresReconciliation,
      lintReason: null,
      synthetic: true,
    };
  }
}
