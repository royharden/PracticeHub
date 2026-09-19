import { describe, expect, it } from 'vitest';

import { clauseDispositions } from './acceptance-dispositions.js';
import { refuseWp046RecordingClause } from './bindings/wp046-voice-workflow-double-v1.js';
import { ENCODED_VOICE_CLAUSES, VoiceAgentError, WP046_OWNED_CLAUSES } from './contracts.js';
import { ConversationRelaySession } from './relay-session.js';

const enabledPolicy = {
  recorded: true,
  decision: 'enabled' as const,
  policyTask: 'human-owned-outbound-ai-voice-policy',
};

function inbound(): ConversationRelaySession {
  return new ConversationRelaySession({
    sessionId: 's1',
    direction: 'inbound',
    purpose: 'treatment',
    consentState: { currentState: 'opted_in' },
    ledgerAvailable: true,
    authenticated: true,
    afterHours: true,
    synthetic: true,
  });
}

describe('WP-047 F1–F4 close', () => {
  it('does not own WP-046 recording clauses', () => {
    expect([...ENCODED_VOICE_CLAUSES]).not.toEqual(
      expect.arrayContaining([...WP046_OWNED_CLAUSES]),
    );
    expect(() => refuseWp046RecordingClause('REQ-VOICE-002')).toThrow(VoiceAgentError);
    expect(clauseDispositions.some((row) => row.fwdId === 'FWD-CONSENT-047-AIVOICE')).toBe(true);
  });

  it('F1 REQ-VOICE-001 outbound is platform-blocked without sponsor policy', () => {
    expect(
      () =>
        new ConversationRelaySession({
          sessionId: 'out',
          direction: 'outbound',
          purpose: 'treatment',
          consentState: { currentState: 'opted_in' },
          ledgerAvailable: true,
          authenticated: true,
          afterHours: false,
          synthetic: true,
        }),
    ).toThrow(VoiceAgentError);
    const allowed = new ConversationRelaySession({
      sessionId: 'out-ok',
      direction: 'outbound',
      purpose: 'treatment',
      consentState: { currentState: 'opted_in' },
      ledgerAvailable: true,
      sponsorPolicy: enabledPolicy,
      authenticated: true,
      afterHours: false,
      synthetic: true,
    });
    expect(allowed.snapshot().outboundAllowed).toBe(true);
  });

  it('F2 canSend refuses voice-shaped opted_in stand-in via opted_out/null/unavailable', () => {
    expect(
      () =>
        new ConversationRelaySession({
          sessionId: 'out',
          direction: 'outbound',
          purpose: 'treatment',
          consentState: null,
          ledgerAvailable: true,
          sponsorPolicy: enabledPolicy,
          authenticated: true,
          afterHours: false,
          synthetic: true,
        }),
    ).toThrow(VoiceAgentError);
    expect(
      () =>
        new ConversationRelaySession({
          sessionId: 'out2',
          direction: 'outbound',
          purpose: 'treatment',
          consentState: { currentState: 'opted_in' },
          ledgerAvailable: false,
          sponsorPolicy: enabledPolicy,
          authenticated: true,
          afterHours: false,
          synthetic: true,
        }),
    ).toThrow(VoiceAgentError);
  });

  it('F3/F4 disclosure+opt-out before tools; emergency barge-in transfers; kill-switch; QA lock', () => {
    const session = inbound();
    expect(session.snapshot().disclosedAi).toBe(true);
    expect(session.snapshot().optOutOffered).toBe(true);
    expect(session.bargeIn('chest pain').warmTransfer).toBe(true);
    expect(session.snapshot().advise911).toBe(true);
    expect(session.snapshot().handoff?.advise911).toBe(true);
    expect(() => session.dismissQa()).toThrow(VoiceAgentError);
    session.recordQaDecision('reviewed');
    expect(session.invokeTool('queue_morning_handoff', true).morningWorklist.length).toBe(1);
    session.kill();
    expect(() => session.bookRoutine()).toThrow(VoiceAgentError);
  });

  it('REQ-VOICE-004 refuses booking while comprehension uncertain', () => {
    const session = inbound();
    session.switchAccessibleChannel(0.1);
    expect(() => session.bookRoutine()).toThrow(VoiceAgentError);
  });

  it('REQ-VOICE-005 tool outage callback without retry', () => {
    const session = inbound();
    expect(session.toolOutage().callbackTask).toBe(true);
    expect(() => session.toolOutage()).toThrow(VoiceAgentError);
  });

  it('REQ-VOICE-006/008 refill gates', () => {
    const unauth = new ConversationRelaySession({
      sessionId: 's2',
      direction: 'inbound',
      purpose: 'treatment',
      consentState: { currentState: 'opted_in' },
      ledgerAvailable: true,
      authenticated: false,
      afterHours: true,
      synthetic: true,
    });
    expect(() => unauth.invokeTool('capture_refill_intake', true)).toThrow(VoiceAgentError);
    expect(inbound().invokeTool('capture_refill_intake', true).refillNotApproval).toBe(true);
    expect(() => inbound().invokeTool('diagnose', true)).toThrow(VoiceAgentError);
  });
});
