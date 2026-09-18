export type Disposition = 'ENCODE' | 'FORWARD-WHOLE';

export interface ClauseDisposition {
  readonly clause: string;
  readonly item: string;
  readonly disposition: Disposition;
  readonly fwdId: string | null;
}

export const clauseDispositions: readonly ClauseDisposition[] = [
  { clause: 'REQ-VOICE-001', item: 'AC1/AC9 platform outbound block + sponsor policy task', disposition: 'ENCODE', fwdId: null },
  { clause: 'REQ-VOICE-001', item: 'EX6 voice grant does not satisfy ai_voice', disposition: 'ENCODE', fwdId: null },
  { clause: 'REQ-VOICE-001', item: 'canSend(ai_voice) opted_in fail-closed', disposition: 'ENCODE', fwdId: null },
  { clause: 'REQ-VOICE-001', item: 'AC2/3/5/6/10 quiet-hours STOP PEWC ledger', disposition: 'FORWARD-WHOLE', fwdId: 'FWD-CONSENT-047-AIVOICE' },
  { clause: 'REQ-VOICE-003', item: 'disclosure + opt-out before tools; warm transfer', disposition: 'ENCODE', fwdId: null },
  { clause: 'REQ-VOICE-003', item: 'full handoff package + recording-state AC1 remainder', disposition: 'FORWARD-WHOLE', fwdId: 'FWD-VOICE-047-003-HANDOFF' },
  { clause: 'REQ-VOICE-004', item: 'low-confidence channel switch; refuse agreement', disposition: 'ENCODE', fwdId: null },
  { clause: 'REQ-VOICE-005', item: 'tool outage callback; no retry; kill-switch halt', disposition: 'ENCODE', fwdId: null },
  { clause: 'REQ-VOICE-006', item: 'unauthenticated refill refuse; no prescribe', disposition: 'ENCODE', fwdId: null },
  { clause: 'REQ-VOICE-006', item: 'structured clinician-owned refill task AC1', disposition: 'FORWARD-WHOLE', fwdId: 'FWD-VOICE-047-006-TASK' },
  { clause: 'REQ-VOICE-007', item: 'disclosure-first; routine book after hours', disposition: 'ENCODE', fwdId: null },
  { clause: 'REQ-VOICE-008', item: 'refill-as-stated; not-an-approval utterance', disposition: 'ENCODE', fwdId: null },
  { clause: 'REQ-VOICE-009', item: 'emergency barge-in warm-transfer + 911 advise', disposition: 'ENCODE', fwdId: null },
  { clause: 'REQ-VOICE-009', item: 'WP-045 classifier + on-call timeout page', disposition: 'FORWARD-WHOLE', fwdId: 'FWD-VOICE-047-009-CLASSIFIER' },
  { clause: 'REQ-VOICE-010', item: 'morning worklist row with intent/outcome', disposition: 'ENCODE', fwdId: null },
  { clause: 'REQ-VOICE-010', item: 'WP-023 overnight completeness remainder', disposition: 'FORWARD-WHOLE', fwdId: 'FWD-VOICE-047-010-WP023' },
  { clause: 'REQ-VOICE-011', item: 'QA required; cannot dismiss without reviewer', disposition: 'ENCODE', fwdId: null },
  { clause: 'REQ-AI', item: 'WP-101 eval/auto-demote family', disposition: 'FORWARD-WHOLE', fwdId: 'FWD-VOICE-047-AI-WP101' },
];
