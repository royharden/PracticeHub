import type { VoiceSessionSnapshot } from './contracts.js';

export function withWarmTransfer(snapshot: VoiceSessionSnapshot, advise911: boolean): VoiceSessionSnapshot {
  return {
    ...snapshot,
    warmTransfer: true,
    channel: 'human',
    emergencyFlag: true,
    qaRequired: true,
    advise911,
    handoff: {
      identity: snapshot.sessionId,
      intent: snapshot.turns[snapshot.turns.length - 1]?.text ?? 'unknown',
      completedActions: snapshot.toolCalls,
      advise911,
    },
    turns: [...snapshot.turns, { kind: 'handoff', text: advise911 ? 'connecting-now-if-life-threat-call-911' : 'connecting-you-to-a-person-now' }],
  };
}

export function withMorningHandoff(snapshot: VoiceSessionSnapshot): VoiceSessionSnapshot {
  const row = {
    sessionId: snapshot.sessionId,
    intent: snapshot.handoff?.intent ?? 'overnight-ai-call',
    outcome: snapshot.warmTransfer ? 'transferred' : 'handled',
    failedTransfer: snapshot.warmTransfer !== true && snapshot.emergencyFlag,
  };
  return {
    ...snapshot,
    morningWorklist: [...snapshot.morningWorklist, row],
    turns: [...snapshot.turns, { kind: 'tool', text: 'queue_morning_handoff', toolName: 'queue_morning_handoff' }],
  };
}
