export type VoiceDisposition = 'ENCODE' | 'FORWARD-WHOLE';

export interface VoiceDispositionRow {
  readonly requirementId: string;
  readonly clause: string;
  readonly disposition: VoiceDisposition;
  readonly owners: readonly string[];
  readonly fwdId: string | null;
  readonly evidence: readonly string[];
}

export const voiceDispositionLedger: readonly VoiceDispositionRow[] = [
  {
    requirementId: 'REQ-VOICE-001',
    clause: 'AC1',
    disposition: 'FORWARD-WHOLE',
    owners: ['WP-047'],
    fwdId: 'FWD-VOICE-047-TCPA-OUTBOUND',
    evidence: [],
  },
  {
    requirementId: 'REQ-VOICE-002',
    clause: 'AC1',
    disposition: 'ENCODE',
    owners: ['WP-046'],
    fwdId: null,
    evidence: [
      'fixtures/REQ-VOICE-002.HAPPY.json',
      'fixtures/REQ-VOICE-002.BOUNDARY.json',
      'fixtures/REQ-VOICE-002.FAILURE.json',
      'fixtures/REQ-VOICE-002.RECOVERY.json',
    ],
  },
  {
    requirementId: 'REQ-VOICE-003',
    clause: 'AC1',
    disposition: 'FORWARD-WHOLE',
    owners: ['WP-047'],
    fwdId: 'FWD-VOICE-047-AI-DISCLOSE-HANDOFF',
    evidence: [],
  },
  {
    requirementId: 'REQ-VOICE-004',
    clause: 'AC1',
    disposition: 'FORWARD-WHOLE',
    owners: ['WP-047'],
    fwdId: 'FWD-VOICE-047-CONFIDENCE-FALLBACK',
    evidence: [],
  },
  {
    requirementId: 'REQ-VOICE-005',
    clause: 'AC1',
    disposition: 'FORWARD-WHOLE',
    owners: ['WP-047'],
    fwdId: 'FWD-VOICE-047-TOOL-OUTAGE',
    evidence: [],
  },
  {
    requirementId: 'REQ-VOICE-006',
    clause: 'AC1',
    disposition: 'FORWARD-WHOLE',
    owners: ['WP-047'],
    fwdId: 'FWD-VOICE-047-AUTH-REFILL',
    evidence: [],
  },
  {
    requirementId: 'REQ-VOICE-007',
    clause: 'AC1',
    disposition: 'FORWARD-WHOLE',
    owners: ['WP-047'],
    fwdId: 'FWD-VOICE-047-AFTER-HOURS-AI-BOOKING',
    evidence: [],
  },
  {
    requirementId: 'REQ-VOICE-008',
    clause: 'AC1',
    disposition: 'FORWARD-WHOLE',
    owners: ['WP-047'],
    fwdId: 'FWD-VOICE-047-AFTER-HOURS-AI-REFILL',
    evidence: [],
  },
  {
    requirementId: 'REQ-VOICE-009',
    clause: 'AC1',
    disposition: 'FORWARD-WHOLE',
    owners: ['WP-047', 'WP-045'],
    fwdId: 'FWD-VOICE-047-AI-EMERGENCY-TRANSFER',
    evidence: [],
  },
  {
    requirementId: 'REQ-VOICE-010',
    clause: 'AC1',
    disposition: 'FORWARD-WHOLE',
    owners: ['WP-047', 'WP-023'],
    fwdId: 'FWD-VOICE-047-MORNING-HANDOFF',
    evidence: [],
  },
  {
    requirementId: 'REQ-VOICE-011',
    clause: 'AC1',
    disposition: 'FORWARD-WHOLE',
    owners: ['WP-047'],
    fwdId: 'FWD-VOICE-047-EMERGENCY-QA',
    evidence: [],
  },
  {
    requirementId: 'REQ-VOICE-012',
    clause: 'AC1',
    disposition: 'ENCODE',
    owners: ['WP-046'],
    fwdId: null,
    evidence: [
      'fixtures/REQ-VOICE-012.HAPPY.json',
      'fixtures/REQ-VOICE-012.BOUNDARY.json',
      'fixtures/REQ-VOICE-012.FAILURE.json',
      'fixtures/REQ-VOICE-012.RECOVERY.json',
    ],
  },
  {
    requirementId: 'REQ-VOICE-013',
    clause: 'AC1',
    disposition: 'ENCODE',
    owners: ['WP-046'],
    fwdId: null,
    evidence: [
      'fixtures/REQ-VOICE-013.HAPPY.json',
      'fixtures/REQ-VOICE-013.BOUNDARY.json',
      'fixtures/REQ-VOICE-013.FAILURE.json',
      'fixtures/REQ-VOICE-013.RECOVERY.json',
    ],
  },
];
