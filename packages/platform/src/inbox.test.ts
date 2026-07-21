import { describe, expect, it } from 'vitest';

import { foldInbox, inboxDedupDecision, inboxKey, InboxError } from './inbox.js';

const eventId = '01H8XGJWBWBAQ4Z5Z5Z5Z5Z5Z5';

describe('inbox dedup', () => {
  it('processes the first sighting and skips every redelivery (per consumer)', () => {
    const seen = foldInbox([]);
    expect(inboxDedupDecision(seen, 'thread-projector', eventId)).toBe('process');
    const after = foldInbox([{ consumer: 'thread-projector', eventId }]);
    expect(inboxDedupDecision(after, 'thread-projector', eventId)).toBe('skip-duplicate');
  });

  it('dedups per consumer — a second consumer still processes the same event', () => {
    const seen = foldInbox([{ consumer: 'thread-projector', eventId }]);
    expect(inboxDedupDecision(seen, 'thread-projector', eventId)).toBe('skip-duplicate');
    expect(inboxDedupDecision(seen, 'sla-timer', eventId)).toBe('process');
  });

  it('keys are (consumer, eventId) pairs', () => {
    expect(inboxKey('sla-timer', eventId)).toBe(`sla-timer|${eventId}`);
  });

  it('rejects a malformed consumer name', () => {
    expect(() => inboxKey('SLA Timer', eventId)).toThrow(InboxError);
  });
});
