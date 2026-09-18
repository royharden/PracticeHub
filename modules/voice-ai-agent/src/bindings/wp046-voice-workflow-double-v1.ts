import { VoiceAgentError, WP046_OWNED_CLAUSES } from '../contracts.js';

export const wp046VoiceWorkflowDoubleV1 = {
  contract: 'practicehub.wp046-voice-workflow-double',
  version: 1 as const,
  parity: 'versioned-double' as const,
  ownedByWp046: WP046_OWNED_CLAUSES,
};

export function refuseWp046RecordingClause(clause: string): void {
  if ((WP046_OWNED_CLAUSES as readonly string[]).includes(clause)) {
    throw new VoiceAgentError('WP046_CLAUSE_NOT_OWNED', clause);
  }
}
