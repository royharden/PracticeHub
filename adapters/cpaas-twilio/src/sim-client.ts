export interface MessageSendRequest {
  readonly tenantId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly payloadRef: string;
  readonly channel: 'sms';
  readonly requestedAt: string;
}

export interface MessageSendResult {
  readonly status:
    | 'accepted'
    | 'deduplicated'
    | 'uncertain'
    | 'rejected'
    | 'throttled'
    | 'unauthorized'
    | 'conflict'
    | 'unavailable'
    | 'malformed';
  readonly effectKey: string;
  readonly receiptRef: string | null;
  readonly requiresReconciliation: boolean;
  readonly deliveryState: 'unknown' | 'accepted' | 'delivered' | 'failed';
  readonly retryAfterSeconds: number | null;
  readonly synthetic: true;
}

interface SimRailResponse {
  readonly railId: 'RAIL-003';
  readonly operation: 'send-message';
  readonly idempotencyKey: string;
  readonly status: MessageSendResult['status'];
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

export class TwilioSimError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TwilioSimError';
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TwilioSimError('simulator returned a malformed envelope');
  }
  return value as Record<string, unknown>;
}

const statuses: readonly MessageSendResult['status'][] = [
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
    response['railId'] !== 'RAIL-003' ||
    response['operation'] !== 'send-message' ||
    response['idempotencyKey'] !== expectedIdempotencyKey ||
    !statuses.includes(response['status'] as MessageSendResult['status']) ||
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
    throw new TwilioSimError('simulator response failed correlation or shape validation');
  }
  return response as unknown as SimRailResponse;
}

function deliveryState(
  effectState: SimRailResponse['effectState'],
): MessageSendResult['deliveryState'] {
  if (effectState === 'landed') return 'accepted';
  if (effectState === 'not-landed') return 'failed';
  return 'unknown';
}

/** Structurally implements @practicehub/comms CpaasPort without a runtime edge. */
export class TwilioSimClient {
  public constructor(private readonly transport: HttpTransport) {}

  public async sendMessage(request: MessageSendRequest): Promise<MessageSendResult> {
    const idempotencyKey = `msg-${createHash('sha256')
      .update(JSON.stringify([request.tenantId, request.messageId]))
      .digest('hex')}`;
    const raw = await this.transport.post('/rails/RAIL-003/send-message', {
      idempotencyKey,
      payloadRef: request.payloadRef,
      requestedAt: request.requestedAt,
      payload: {
        threadRef: JSON.stringify([request.tenantId, request.threadId]),
        channel: request.channel,
      },
      synthetic: true,
    });
    const response = parseResponse(raw, idempotencyKey);
    return {
      status: response.status,
      effectKey: response.effectKey,
      receiptRef: response.receiptRef,
      requiresReconciliation: response.requiresReconciliation,
      deliveryState: deliveryState(response.effectState),
      retryAfterSeconds: response.retryAfterSeconds,
      synthetic: true,
    };
  }

  public async drainReceipts(): Promise<unknown> {
    return this.transport.get('/receipts/RAIL-003');
  }
}
import { createHash } from 'node:crypto';
