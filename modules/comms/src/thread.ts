import type { ContextPackage, WorkItemEvent } from '@practicehub/events';

export const threadStatuses = ['open', 'resolved'] as const;
export type ThreadStatus = (typeof threadStatuses)[number];
export type DeliveryState = 'unknown' | 'accepted' | 'delivered' | 'failed';

export interface ThreadMessage {
  readonly messageId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly contentRef: string;
  readonly occurredAt: string;
  readonly vendorEventKey: string;
  readonly effectKey: string | null;
  readonly deliveryState: DeliveryState;
  readonly holding: boolean;
}

export interface Thread {
  readonly tenantId: string;
  readonly threadId: string;
  readonly personRef: string | null;
  readonly workItemId: string;
  readonly channel: 'sms';
  readonly purpose: 'treatment' | 'payment' | 'operations' | 'marketing';
  readonly ownerRef: string | null;
  readonly escalated: boolean;
  readonly status: ThreadStatus;
  readonly messages: readonly ThreadMessage[];
  readonly resolutionDisposition: string | null;
  readonly resolutionEvidenceRef: string | null;
}

export class ThreadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ThreadError';
  }
}

export function tenantScopedKey(tenantId: string, value: string): string {
  if (tenantId.trim() === '' || value.trim() === '') {
    throw new ThreadError('tenant and key components are required');
  }
  return JSON.stringify([tenantId, value]);
}

export function openThread(input: {
  readonly tenantId: string;
  readonly threadId: string;
  readonly personRef: string | null;
  readonly workItemId: string;
  readonly channel: 'sms';
  readonly purpose: Thread['purpose'];
  readonly ownerRef: string | null;
  readonly escalated?: boolean;
}): Thread {
  return {
    ...input,
    escalated: input.escalated ?? false,
    status: 'open',
    messages: [],
    resolutionDisposition: null,
    resolutionEvidenceRef: null,
  };
}

export function recordMessage(
  thread: Thread,
  message: Omit<ThreadMessage, 'deliveryState' | 'effectKey'> & {
    readonly deliveryState?: DeliveryState;
    readonly effectKey?: string | null;
  },
): Thread {
  if (thread.status === 'resolved') {
    throw new ThreadError('a resolved thread cannot accept a message');
  }
  if (!Number.isFinite(Date.parse(message.occurredAt))) {
    throw new ThreadError('message occurredAt must be a valid timestamp');
  }
  const scopedVendorKey = tenantScopedKey(thread.tenantId, message.vendorEventKey);
  const duplicate = thread.messages.find(
    (candidate) => tenantScopedKey(thread.tenantId, candidate.vendorEventKey) === scopedVendorKey,
  );
  if (duplicate !== undefined) {
    const identical =
      duplicate.messageId === message.messageId &&
      duplicate.direction === message.direction &&
      duplicate.contentRef === message.contentRef &&
      Date.parse(duplicate.occurredAt) === Date.parse(message.occurredAt) &&
      duplicate.holding === message.holding &&
      duplicate.effectKey === (message.effectKey ?? null);
    if (!identical) throw new ThreadError('duplicate vendor key changed message payload');
    return thread;
  }
  return {
    ...thread,
    messages: [
      ...thread.messages,
      {
        ...message,
        effectKey: message.effectKey ?? null,
        deliveryState: message.deliveryState ?? 'unknown',
      },
    ],
  };
}

export function reconcileDelivery(
  thread: Thread,
  receipt: {
    readonly messageId: string;
    readonly messageVendorEventKey: string;
    readonly receiptEventKey: string;
    readonly effectKey: string;
    readonly outcome: Exclude<DeliveryState, 'unknown'> | null;
    readonly observedAt: string;
  },
): Thread {
  if (!Number.isFinite(Date.parse(receipt.observedAt))) {
    throw new ThreadError('receipt observedAt must be a valid timestamp');
  }
  const target = thread.messages.find((message) => message.messageId === receipt.messageId);
  if (target === undefined) throw new ThreadError(`unknown message ${receipt.messageId}`);
  if (
    target.vendorEventKey !== receipt.messageVendorEventKey ||
    target.effectKey !== receipt.effectKey
  ) {
    throw new ThreadError('receipt does not correlate to message effect');
  }
  if (Date.parse(receipt.observedAt) < Date.parse(target.occurredAt)) {
    throw new ThreadError('receipt predates message');
  }
  if (receipt.outcome === null) return thread;
  const outcome = receipt.outcome;
  const messages = thread.messages.map((message) => {
    if (message.messageId !== receipt.messageId) return message;
    if (message.deliveryState === 'delivered' || message.deliveryState === 'failed') {
      if (outcome !== message.deliveryState) {
        throw new ThreadError('receipt would regress a terminal delivery state');
      }
      return message;
    }
    if (message.deliveryState === 'accepted' && outcome === 'accepted') return message;
    return { ...message, deliveryState: outcome };
  });
  return { ...thread, messages };
}

export function resolveThread(
  thread: Thread,
  input: { readonly disposition: string; readonly evidenceRef: string },
): Thread {
  if (input.disposition.trim() === '' || input.evidenceRef.trim() === '') {
    throw new ThreadError('resolution requires both disposition and evidence');
  }
  return {
    ...thread,
    status: 'resolved',
    resolutionDisposition: input.disposition,
    resolutionEvidenceRef: input.evidenceRef,
  };
}

export interface AuthorizedThreadView {
  readonly thread: Thread;
  readonly context: ContextPackage;
  readonly taskEvents: readonly WorkItemEvent[];
}

export interface ThreadReadPort {
  authorize(input: {
    readonly tenantId: string;
    readonly actorRef: string;
    readonly threadId: string;
  }): Promise<boolean>;
  loadThread(tenantId: string, threadId: string): Promise<Thread | null>;
  loadContext(
    tenantId: string,
    workItemId: string,
  ): Promise<{ readonly workItemId: string; readonly context: ContextPackage }>;
  loadTaskEvents(tenantId: string, workItemId: string): Promise<readonly WorkItemEvent[]>;
}

export async function readAuthorizedThread(
  port: ThreadReadPort,
  input: { readonly tenantId: string; readonly actorRef: string; readonly threadId: string },
): Promise<AuthorizedThreadView> {
  if (!(await port.authorize(input))) throw new ThreadError('thread access denied');
  const thread = await port.loadThread(input.tenantId, input.threadId);
  if (thread === null || thread.tenantId !== input.tenantId || thread.threadId !== input.threadId) {
    throw new ThreadError('thread not found');
  }
  const [contextResult, taskEvents] = await Promise.all([
    port.loadContext(input.tenantId, thread.workItemId),
    port.loadTaskEvents(input.tenantId, thread.workItemId),
  ]);
  if (
    contextResult.workItemId !== thread.workItemId ||
    taskEvents.some((event) => event.workItemId !== thread.workItemId)
  ) {
    throw new ThreadError('thread context correlation mismatch');
  }
  return { thread, context: contextResult.context, taskEvents };
}
