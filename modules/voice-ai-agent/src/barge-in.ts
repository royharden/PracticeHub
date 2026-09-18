import type { RelayTurn } from './contracts.js';

export function applyBargeIn(turns: readonly RelayTurn[], userText: string): RelayTurn[] {
  const withoutOpenSpeech = turns.filter((turn) => turn.kind !== 'agent_speech');
  return [
    ...withoutOpenSpeech,
    { kind: 'barge_in', text: 'interrupt' },
    { kind: 'user_speech', text: userText },
  ];
}
