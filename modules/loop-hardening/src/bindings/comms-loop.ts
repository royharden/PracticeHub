import type { ConsentStateRow } from '@practicehub/consent';
import {
  openThread,
  reconcileDelivery,
  recordMessage,
  sendAccountableMessage,
  type AccountableMessagePorts,
  type Thread,
} from '@practicehub/comms';
import { TwilioSimClient, type HttpTransport } from '@practicehub/cpaas-twilio';
import type { WorkItemEvent } from '@practicehub/events';
import {
  VendorSimEngine,
  type RailRequest,
  type RailResponse,
  type SimReceipt,
} from '@practicehub/vendor-sim-kit';

import type { LoopBinding, OwnedException, ProductObservation } from '../harness.js';
import type { KillPoint } from '../manifest.js';

const occurredAt = '2026-09-12T15:00:00.000Z';

class EngineTransport implements HttpTransport {
  public readonly responses: RailResponse[] = [];

  public constructor(private readonly engine: VendorSimEngine) {}

  public post(path: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (path !== '/rails/RAIL-003/send-message') {
      return Promise.reject(new Error(`WP033_UNKNOWN_COMMS_ROUTE:${path}`));
    }
    const response = this.engine.dispatch({
      railId: 'RAIL-003',
      operation: 'send-message',
      idempotencyKey: String(body['idempotencyKey']),
      payloadRef: String(body['payloadRef']),
      requestedAt: String(body['requestedAt']),
      payload: body['payload'],
      synthetic: true,
    } satisfies RailRequest);
    this.responses.push(response);
    return Promise.resolve({ response, synthetic: true });
  }

  public get(path: string): Promise<unknown> {
    if (path !== '/receipts/RAIL-003') {
      return Promise.reject(new Error(`WP033_UNKNOWN_COMMS_ROUTE:${path}`));
    }
    return Promise.resolve({ receipts: this.engine.drainReceipts('RAIL-003'), synthetic: true });
  }
}

export class CommsLoopBinding implements LoopBinding {
  readonly #transport: EngineTransport;
  readonly #client: TwilioSimClient;
  readonly #consentAudits: string[] = [];
  readonly #receiptEvidence: string[] = [];
  readonly #receipts: SimReceipt[] = [];
  readonly #exceptionEvidence: string[] = [];
  readonly #taskEvents: WorkItemEvent[] = [];
  readonly #taskEventKeys = new Set<string>();
  #thread: Thread;
  #ownedException: OwnedException | undefined;
  #transitionCount = 0;
  #terminalRegression = false;
  #dispatchAttempts = 0;

  public constructor(
    private readonly engine: VendorSimEngine,
    private readonly applicationKey: string,
  ) {
    this.#transport = new EngineTransport(engine);
    this.#client = new TwilioSimClient(this.#transport);
    this.#thread = openThread({
      tenantId: 'northwind-synthetic',
      threadId: 'wp033-thread-1',
      personRef: 'wp033-person-1',
      workItemId: 'wp033-comms-work-1',
      channel: 'sms',
      purpose: 'treatment',
      ownerRef: 'synthetic-staff:communications-1',
    });
  }

  public async dispatch(): Promise<void> {
    this.#dispatchAttempts += 1;
    const outcome = await sendAccountableMessage(this.ports(), {
      thread: this.#thread,
      consent: this.consentState(),
      actorRef: 'synthetic-staff:communications-1',
      messageId: this.applicationKey,
      payloadRef: 'payload:wp033-message-1',
      occurredAt,
    });
    if (outcome.rail === null) throw new Error('WP033_COMMS_CONSENT_UNEXPECTEDLY_DENIED');
    this.#thread = recordMessage(this.#thread, {
      messageId: this.applicationKey,
      direction: 'outbound',
      contentRef: 'payload:wp033-message-1',
      occurredAt,
      vendorEventKey: `vendor-${this.applicationKey}`,
      effectKey: outcome.rail.effectKey,
      deliveryState: outcome.rail.deliveryState,
      holding: false,
    });
  }

  public async recover(killPoint: KillPoint): Promise<void> {
    if (killPoint === 'after-effect-before-receipt') {
      const effect = this.engine.snapshot().effects[0];
      if (effect === undefined || effect.state !== 'unknown') {
        throw new Error('WP033_COMMS_UNKNOWN_LEDGER_REQUIRED');
      }
      this.#thread = recordMessage(this.#thread, {
        messageId: this.applicationKey,
        direction: 'outbound',
        contentRef: 'payload:wp033-message-1',
        occurredAt,
        vendorEventKey: `vendor-${this.applicationKey}`,
        effectKey: effect.effectKey,
        deliveryState: 'unknown',
        holding: false,
      });
      await this.holdUnknown('CPaaS_OUTCOME_UNKNOWN');
      return;
    }
    await this.dispatch();
  }

  public async settle(): Promise<void> {
    const receipts = this.engine.drainReceipts('RAIL-003');
    this.#receipts.push(...receipts);
    for (const receipt of receipts) this.applyReceipt(receipt);
    const message = this.#thread.messages.find(
      (candidate) => candidate.messageId === this.applicationKey,
    );
    if (message?.deliveryState === 'unknown') await this.holdUnknown('CPaaS_RECEIPT_MISSING');
  }

  public productObservation(): ProductObservation {
    const message = this.#thread.messages.find(
      (candidate) => candidate.messageId === this.applicationKey,
    );
    const assigned = this.#taskEvents.find((event) => event.eventType === 'assigned');
    const timer = this.#taskEvents.find((event) => event.eventType === 'timer_started');
    return {
      state: message?.deliveryState ?? 'not-dispatched',
      transitionCount: this.#transitionCount,
      evidenceRefs: [...this.#receiptEvidence, ...this.#exceptionEvidence],
      ...(this.#ownedException === undefined ? {} : { ownedException: this.#ownedException }),
      correlationExact:
        this.#thread.tenantId === 'northwind-synthetic' &&
        this.#thread.personRef === 'wp033-person-1' &&
        this.#thread.messages.length <= 1 &&
        (message === undefined ||
          message.effectKey === this.engine.snapshot().effects[0]?.effectKey) &&
        (this.#ownedException === undefined ||
          (assigned?.workItemId === this.#thread.workItemId &&
            assigned.toOwnerRef === this.#ownedException.ownerRef &&
            timer?.workItemId === this.#thread.workItemId &&
            timer.dueAt === this.#ownedException.dueAt)),
      terminalRegression: this.#terminalRegression,
      consentChecked: this.#consentAudits.length > 0,
      recoveryAttempts: this.#dispatchAttempts,
      receiptIngressCount: this.#receipts.length,
    };
  }

  public railResponses(): readonly RailResponse[] {
    return this.#transport.responses;
  }

  public receipts(): readonly SimReceipt[] {
    return this.#receipts;
  }

  private ports(): AccountableMessagePorts {
    return {
      cpaas: this.#client,
      appendConsentAudit: (audit) => {
        this.#consentAudits.push(audit.correlationRef);
        return Promise.resolve();
      },
      appendTaskEventsOnce: (tenantId, idempotencyKey, events) => {
        if (tenantId !== this.#thread.tenantId) throw new Error('WP033_COMMS_TASK_TENANT_MISMATCH');
        if (!this.#taskEventKeys.has(idempotencyKey)) {
          this.#taskEventKeys.add(idempotencyKey);
          this.#taskEvents.push(...events);
        }
        return Promise.resolve();
      },
    };
  }

  private consentState() {
    const state: ConsentStateRow = {
      tenantId: 'northwind-synthetic',
      personRef: 'wp033-person-1',
      scopeKey: 'communication|channel=sms|purpose=treatment',
      scopeType: 'communication',
      channel: 'sms',
      purpose: 'treatment',
      currentState: 'opted_in',
      effectiveAt: occurredAt,
      lastEventId: 'wp033-consent-1',
      quietHoursTz: 'UTC',
      jurisdiction: 'virtual',
      synthetic: true,
    };
    return {
      tenantId: state.tenantId,
      personRef: state.personRef,
      channel: 'sms' as const,
      purpose: 'treatment' as const,
      state,
      urgency: 'routine' as const,
      asOf: occurredAt,
      actorRef: 'synthetic-staff:communications-1',
      occurredAt,
    };
  }

  private applyReceipt(receipt: SimReceipt): void {
    const before = this.#thread.messages.find(
      (candidate) => candidate.messageId === this.applicationKey,
    )?.deliveryState;
    if (before === undefined) throw new Error('WP033_COMMS_RECEIPT_WITHOUT_MESSAGE');
    try {
      this.#thread = reconcileDelivery(this.#thread, {
        messageId: this.applicationKey,
        messageVendorEventKey: `vendor-${this.applicationKey}`,
        receiptEventKey: `${receipt.receiptRef}:${String(receipt.sequence)}`,
        effectKey: receipt.effectKey,
        outcome: 'delivered',
        observedAt: receipt.emittedAt,
      });
    } catch (error) {
      this.#terminalRegression = true;
      throw error;
    }
    const after = this.#thread.messages.find(
      (candidate) => candidate.messageId === this.applicationKey,
    )?.deliveryState;
    if (before !== 'delivered' && after === 'delivered') this.#transitionCount += 1;
    this.#receiptEvidence.push(`${receipt.receiptRef}:${String(receipt.sequence)}`);
    this.#ownedException = undefined;
  }

  private async holdUnknown(reason: string): Promise<void> {
    if (this.#ownedException !== undefined) return;
    const exception: OwnedException = {
      ownerRef: 'synthetic-staff:communications-1',
      dueAt: '2026-09-12T15:15:00.000Z',
      reason,
      evidenceRef: `exception:${this.applicationKey}`,
    };
    this.#ownedException = exception;
    await this.ports().appendTaskEventsOnce(
      this.#thread.tenantId,
      `wp033-unknown-${this.applicationKey}`,
      [
        {
          workItemId: this.#thread.workItemId,
          eventSeq: 1,
          eventType: 'assigned',
          occurredAt,
          actorRef: 'system:wp033-loop-hardening',
          toOwnerRef: exception.ownerRef,
          reason: 'assignment',
        },
        {
          workItemId: this.#thread.workItemId,
          eventSeq: 2,
          eventType: 'timer_started',
          occurredAt,
          actorRef: 'system:wp033-loop-hardening',
          timerType: 'resolution',
          dueAt: exception.dueAt,
        },
      ],
    );
    for (const event of this.#taskEvents) {
      this.#exceptionEvidence.push(
        `task-event:${event.workItemId}:${String(event.eventSeq)}:${event.eventType}`,
      );
    }
  }
}

export async function runCommsConsentDenialProbe(): Promise<{
  readonly railEffects: number;
  readonly audited: boolean;
}> {
  const engine = new VendorSimEngine({ rails: [] });
  let audited = false;
  const thread = openThread({
    tenantId: 'northwind-synthetic',
    threadId: 'wp033-consent-denial',
    personRef: 'wp033-person-1',
    workItemId: 'wp033-consent-work-1',
    channel: 'sms',
    purpose: 'treatment',
    ownerRef: 'synthetic-staff:communications-1',
  });
  await sendAccountableMessage(
    {
      cpaas: { sendMessage: () => Promise.reject(new Error('RAIL_MUST_NOT_BE_CALLED')) },
      appendConsentAudit: () => {
        audited = true;
        return Promise.resolve();
      },
      appendTaskEventsOnce: () => Promise.resolve(),
    },
    {
      thread,
      consent: {
        tenantId: thread.tenantId,
        personRef: String(thread.personRef),
        channel: 'sms',
        purpose: 'treatment',
        state: null,
        urgency: 'routine',
        asOf: occurredAt,
        actorRef: 'synthetic-staff:communications-1',
        occurredAt,
      },
      actorRef: 'synthetic-staff:communications-1',
      messageId: 'wp033-denied-message',
      payloadRef: 'payload:wp033-denied-message',
      occurredAt,
    },
  );
  return { railEffects: engine.snapshot().effects.length, audited };
}
