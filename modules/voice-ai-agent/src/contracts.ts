export const ENCODED_VOICE_CLAUSES = [
  'REQ-VOICE-001',
  'REQ-VOICE-003',
  'REQ-VOICE-004',
  'REQ-VOICE-005',
  'REQ-VOICE-006',
  'REQ-VOICE-007',
  'REQ-VOICE-008',
  'REQ-VOICE-009',
  'REQ-VOICE-010',
  'REQ-VOICE-011',
] as const;

export const WP046_OWNED_CLAUSES = ['REQ-VOICE-002', 'REQ-VOICE-012', 'REQ-VOICE-013'] as const;

export type EncodedVoiceClause = (typeof ENCODED_VOICE_CLAUSES)[number];
export type Direction = 'inbound' | 'outbound';
export type ToolName =
  'book_routine' | 'capture_refill_intake' | 'transfer_oncall' | 'queue_morning_handoff';

export class VoiceAgentError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VoiceAgentError';
  }
}

export interface RelayTurn {
  readonly kind:
    'agent_speech' | 'user_speech' | 'barge_in' | 'tool' | 'handoff' | 'blocked' | 'opt_out';
  readonly text: string;
  readonly toolName?: ToolName;
}

export interface HandoffContext {
  readonly identity: string;
  readonly intent: string;
  readonly completedActions: readonly string[];
  readonly advise911: boolean;
}

export interface MorningWorklistRow {
  readonly sessionId: string;
  readonly intent: string;
  readonly outcome: string;
  readonly failedTransfer: boolean;
}

export interface VoiceSessionSnapshot {
  readonly sessionId: string;
  readonly direction: Direction;
  readonly disclosedAi: boolean;
  readonly optOutOffered: boolean;
  readonly outboundAllowed: boolean;
  readonly interrupted: boolean;
  readonly toolCalls: readonly ToolName[];
  readonly retryCount: number;
  readonly language: string;
  readonly channel: 'voice' | 'sms' | 'human';
  readonly warmTransfer: boolean;
  readonly emergencyFlag: boolean;
  readonly qaRequired: boolean;
  readonly qaDismissed: boolean;
  readonly qaReviewerDecision: string | null;
  readonly morningWorklist: readonly MorningWorklistRow[];
  readonly authenticated: boolean;
  readonly afterHours: boolean;
  readonly callbackTask: boolean;
  readonly advise911: boolean;
  readonly killSwitchEngaged: boolean;
  readonly comprehensionUncertain: boolean;
  readonly refillNotApproval: boolean;
  readonly handoff: HandoffContext | null;
  readonly turns: readonly RelayTurn[];
  readonly synthetic: true;
}
