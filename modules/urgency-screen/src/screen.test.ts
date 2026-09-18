import { describe, expect, it } from 'vitest';
import { assistiveAiScreen } from './ai-screen-double.js';
import { screenInbound } from './screen.js';
import { EMERGENCY_LINE, type UrgencyScreenInput } from './types.js';

function inbound(overrides: Partial<UrgencyScreenInput> = {}): UrgencyScreenInput {
  return {
    tenantId: 'tenant-synthetic-a',
    inboundId: 'inbound-1',
    receivedAt: '2026-09-18T03:00:00Z',
    channel: 'sms',
    language: 'en',
    text: 'Need a refill next week',
    unmatched: false,
    afterHours: true,
    killSwitchTripped: false,
    synthetic: true,
    ...overrides,
  };
}

describe('WP-045 urgency screen', () => {
  it('HAPPY: after-hours chest pain is urgent and pages on-call', () => {
    const fact = screenInbound(inbound({ text: 'I have chest pain' }));
    expect(fact.class).toBe('urgent');
    expect(fact.routing).toBe('page_oncall');
    expect(fact.advisoryOnly).toBe(true);
    expect(fact.emergencyLineRequired).toBe(true);
    expect(fact.reasons.some((reason) => reason.includes(EMERGENCY_LINE))).toBe(true);
  });

  it('HAPPY: after-hours refill is routine and queues until open', () => {
    const fact = screenInbound(inbound({ text: 'Need a refill next week' }));
    expect(fact.class).toBe('routine');
    expect(fact.routing).toBe('queue_until_open');
  });

  it('BOUNDARY: unmatched numbers still get content-first screening', () => {
    const fact = screenInbound(inbound({ unmatched: true, text: 'cannot breathe' }));
    expect(fact.unmatched).toBe(true);
    expect(fact.class).toBe('urgent');
    expect(fact.routing).toBe('page_oncall');
  });

  it('BOUNDARY: Spanish emergency language hits the same urgent class', () => {
    const fact = screenInbound(inbound({ language: 'es', text: 'Es una emergencia, dolor de pecho' }));
    expect(fact.class).toBe('urgent');
    expect(fact.reasons.some((reason) => reason.includes('keyword:es:emergencia'))).toBe(true);
  });

  it('BOUNDARY: business-hours urgent content still classifies; it does not page', () => {
    const fact = screenInbound(inbound({ afterHours: false, text: 'stroke symptoms now' }));
    expect(fact.class).toBe('urgent');
    expect(fact.routing).toBe('queue_until_open');
  });

  it('FAILURE: kill-switch never silently routines; it forces human review', () => {
    const fact = screenInbound(inbound({ killSwitchTripped: true, text: 'Need a refill next week' }));
    expect(fact.humanFallback).toBe(true);
    expect(fact.routing).toBe('human_review');
    expect(fact.class).toBe('urgent');
  });

  it('FAILURE: assistive AI cannot downgrade a keyword-urgent decision', () => {
    const ai = assistiveAiScreen({
      text: 'this looks calm actually',
      keywordClass: 'urgent',
      killSwitchTripped: false,
    });
    expect(ai.class).toBe('urgent');
    expect(ai.confidence).toBe(1);
  });

  it('RECOVERY: assistive AI may escalate a keyword-routine case', () => {
    const fact = screenInbound(inbound({ text: 'worst headache of my life' }));
    expect(fact.class).toBe('urgent');
    expect(fact.routing).toBe('page_oncall');
  });

  it('rejects non-synthetic inbound', () => {
    expect(() =>
      screenInbound({ ...inbound(), synthetic: false } as unknown as UrgencyScreenInput),
    ).toThrow(/synthetic inbound only/);
  });
});
