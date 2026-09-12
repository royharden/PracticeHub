import {
  canSend,
  canonicalConsentScopeKey,
  type CanSendInput,
  type ConsentAuditInput,
  type ConsentDecision,
} from '@practicehub/consent';
import { holdingReplyEvents, type ContextPackage, type WorkItemEvent } from '@practicehub/events';

import { tenantScopedKey, type DeliveryState, type Thread } from './thread.js';

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
  readonly deliveryState: DeliveryState;
  readonly retryAfterSeconds?: number | null;
  readonly synthetic: true;
}

export interface CpaasPort {
  sendMessage(request: MessageSendRequest): Promise<MessageSendResult>;
}

export interface AccountableMessagePorts {
  readonly cpaas: CpaasPort;
  appendConsentAudit(input: ConsentAuditInput): Promise<void>;
  appendTaskEventsOnce(
    tenantId: string,
    idempotencyKey: string,
    events: readonly WorkItemEvent[],
  ): Promise<void>;
}

export interface SendOutcome {
  readonly consent: ConsentDecision;
  readonly rail: MessageSendResult | null;
  readonly taskEvents: readonly WorkItemEvent[];
}

export async function sendAccountableMessage(
  ports: AccountableMessagePorts,
  input: {
    readonly thread: Thread;
    readonly consent: CanSendInput;
    readonly actorRef: string;
    readonly messageId: string;
    readonly payloadRef: string;
    readonly occurredAt: string;
    readonly holding?: { readonly resolutionDueAt: string; readonly taskBaseSeq: number };
  },
): Promise<SendOutcome> {
  if (input.thread.status !== 'open') throw new Error('cannot send on a resolved thread');
  if (input.thread.personRef === null || input.thread.personRef !== input.consent.personRef) {
    throw new Error('send requires an exactly matched thread person');
  }
  if (input.thread.tenantId !== input.consent.tenantId) {
    throw new Error('cross-tenant consent is forbidden');
  }
  if (
    input.consent.channel !== input.thread.channel ||
    input.consent.channel !== 'sms' ||
    input.consent.purpose !== input.thread.purpose
  ) {
    throw new Error('consent scope does not match the actual thread send');
  }
  const state = input.consent.state;
  if (
    state !== null &&
    (state.tenantId !== input.thread.tenantId ||
      state.personRef !== input.thread.personRef ||
      state.scopeType !== 'communication' ||
      state.channel !== input.thread.channel ||
      state.purpose !== input.thread.purpose ||
      state.scopeKey !==
        canonicalConsentScopeKey({
          channel: input.thread.channel,
          purpose: input.thread.purpose,
          type: 'communication',
        }))
  ) {
    throw new Error('consent state does not match the actual thread send');
  }

  const consent = canSend({
    ...input.consent,
    actorRef: input.actorRef,
    asOf: input.occurredAt,
    occurredAt: input.occurredAt,
  });
  await ports.appendConsentAudit(consent.auditInput);
  if (!consent.allow) return { consent, rail: null, taskEvents: [] };

  const rail = await ports.cpaas.sendMessage({
    tenantId: input.thread.tenantId,
    threadId: input.thread.threadId,
    messageId: input.messageId,
    payloadRef: input.payloadRef,
    channel: 'sms',
    requestedAt: input.occurredAt,
  });
  const railRecorded =
    (rail.status === 'accepted' || rail.status === 'deduplicated') &&
    (rail.deliveryState === 'accepted' || rail.deliveryState === 'delivered');
  const taskEvents =
    input.holding && railRecorded
      ? holdingReplyEvents({
          workItemId: input.thread.workItemId,
          baseSeq: input.holding.taskBaseSeq,
          occurredAt: input.occurredAt,
          actorRef: input.actorRef,
          resolutionDueAt: input.holding.resolutionDueAt,
        })
      : [];
  if (taskEvents.length > 0) {
    await ports.appendTaskEventsOnce(
      input.thread.tenantId,
      tenantScopedKey(
        input.thread.tenantId,
        JSON.stringify([input.thread.threadId, input.messageId, 'holding']),
      ),
      taskEvents,
    );
  }
  return { consent, rail, taskEvents };
}

export function claimThreadEvents(input: {
  readonly thread: Thread;
  readonly taskBaseSeq: number;
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly context: ContextPackage;
}): readonly WorkItemEvent[] {
  if (input.thread.status === 'resolved') throw new Error('a resolved thread is not claimable');
  if (input.thread.ownerRef !== null && !input.thread.escalated) throw new Error('already claimed');
  const takingOver = input.thread.ownerRef !== null;
  return [
    {
      workItemId: input.thread.workItemId,
      eventSeq: input.taskBaseSeq + 1,
      eventType: takingOver ? 'reassigned' : 'claimed',
      occurredAt: input.occurredAt,
      actorRef: input.actorRef,
      ...(takingOver ? { fromOwnerRef: input.thread.ownerRef ?? undefined } : {}),
      toOwnerRef: input.actorRef,
      reason: takingOver ? 'escalation' : 'claim',
      contextPackage: input.context,
    },
  ];
}

export function escalationNotificationKeys(input: {
  readonly tenantId: string;
  readonly threadId: string;
  readonly step: number;
}): { readonly primary: string; readonly fallback: string } {
  const base = tenantScopedKey(input.tenantId, `${input.threadId}:escalation:${input.step}`);
  return { primary: `${base}:push`, fallback: `${base}:sms` };
}
