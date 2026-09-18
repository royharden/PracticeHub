export interface StripeWebhook {
  readonly tenantId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly type: string;
  readonly payloadRef: string;
  readonly receivedAt: string;
}

export type InboxIngestStatus = 'applied' | 'duplicate' | 'buffered' | 'stale';

export interface InboxIngestResult {
  readonly status: InboxIngestStatus;
  readonly appliedEffectKeys: readonly string[];
  readonly missingSequences: readonly number[];
}

interface StoredEvent extends StripeWebhook {
  readonly effectKey: string;
  applied: boolean;
}

/**
 * Tenant-scoped webhook inbox: duplicate event ids do not create a second
 * effect; later sequences buffer until the gap fills; gap-check reports holes.
 */
export class StripeWebhookInbox {
  private readonly byEventId = new Map<string, StoredEvent>();
  private readonly buffered = new Map<number, StoredEvent>();
  private nextSequence = 1;

  public ingest(event: StripeWebhook): InboxIngestResult {
    if (event.sequence < 1) {
      return { status: 'stale', appliedEffectKeys: [], missingSequences: this.gaps() };
    }
    const existing = this.byEventId.get(event.eventId);
    if (existing !== undefined) {
      return {
        status: 'duplicate',
        appliedEffectKeys: existing.applied ? [existing.effectKey] : [],
        missingSequences: this.gaps(),
      };
    }
    const stored: StoredEvent = {
      ...event,
      effectKey: `wh-${event.tenantId}-${event.eventId}`,
      applied: false,
    };
    this.byEventId.set(event.eventId, stored);
    if (event.sequence < this.nextSequence) {
      return { status: 'stale', appliedEffectKeys: [], missingSequences: this.gaps() };
    }
    if (event.sequence > this.nextSequence) {
      this.buffered.set(event.sequence, stored);
      return { status: 'buffered', appliedEffectKeys: [], missingSequences: this.gaps() };
    }
    const applied = this.drainFrom(stored);
    return { status: 'applied', appliedEffectKeys: applied, missingSequences: this.gaps() };
  }

  public replay(eventId: string): InboxIngestResult {
    const existing = this.byEventId.get(eventId);
    if (existing === undefined) {
      return { status: 'stale', appliedEffectKeys: [], missingSequences: this.gaps() };
    }
    return {
      status: 'duplicate',
      appliedEffectKeys: existing.applied ? [existing.effectKey] : [],
      missingSequences: this.gaps(),
    };
  }

  public gaps(): readonly number[] {
    if (this.buffered.size === 0) {
      return [];
    }
    const max = Math.max(...this.buffered.keys());
    const missing: number[] = [];
    for (let sequence = this.nextSequence; sequence <= max; sequence += 1) {
      if (!this.buffered.has(sequence)) {
        missing.push(sequence);
      }
    }
    return missing;
  }

  private drainFrom(head: StoredEvent): string[] {
    const applied: string[] = [];
    let current: StoredEvent | undefined = head;
    while (current !== undefined) {
      current.applied = true;
      applied.push(current.effectKey);
      this.buffered.delete(current.sequence);
      this.nextSequence = current.sequence + 1;
      current = this.buffered.get(this.nextSequence);
    }
    return applied;
  }
}
