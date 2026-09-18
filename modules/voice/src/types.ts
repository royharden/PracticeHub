export const callDirections = ['inbound', 'outbound'] as const;
export type CallDirection = (typeof callDirections)[number];

export const recordingRules = ['all-party', 'one-party'] as const;
export type RecordingRule = (typeof recordingRules)[number];

export const consentCaptures = ['granted', 'refused', 'uncertain', 'missing'] as const;
export type ConsentCapture = (typeof consentCaptures)[number];

export const recordingOutcomes = [
  'recording-permitted',
  'unrecorded-service',
  'quarantined',
  'hold-human-verify',
  'purge-required',
  'legal-hold-retain',
] as const;
export type RecordingOutcome = (typeof recordingOutcomes)[number];

export const callWorkflowStates = [
  'ringing',
  'in-progress',
  'voicemail',
  'handed-off',
  'completed',
  'failed-open-to-callback',
] as const;
export type CallWorkflowState = (typeof callWorkflowStates)[number];

export interface VoiceParty {
  readonly partyId: string;
  readonly role: 'caller' | 'callee' | 'additional';
  readonly consent: ConsentCapture;
}

export interface RecordingDecision {
  readonly tenantId: string;
  readonly callId: string;
  readonly rule: RecordingRule;
  readonly parties: readonly VoiceParty[];
  readonly recordingBytesPresent: boolean;
  readonly legalHold: boolean;
  readonly outcome: RecordingOutcome;
  readonly workflowPermitted: boolean;
  readonly transcriptPermitted: boolean;
  readonly playbackPermitted: boolean;
  readonly synthetic: true;
}

export interface CallSession {
  readonly tenantId: string;
  readonly callId: string;
  readonly direction: CallDirection;
  readonly state: CallWorkflowState;
  readonly recording: RecordingDecision | null;
  readonly workItemId: string | null;
  readonly contextPackageRef: string | null;
  readonly synthetic: true;
}

export class VoiceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'VoiceError';
  }
}

export function requireSynthetic(synthetic: boolean): void {
  if (synthetic !== true) {
    throw new VoiceError('voice facts must be synthetic');
  }
}
