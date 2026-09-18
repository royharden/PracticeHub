import type { CallSession } from './types.js';
import { VoiceError } from './types.js';
import type { OnCallContextDouble, UrgencyScreenDouble } from './ports.js';

export interface VoicemailTriage {
  readonly tenantId: string;
  readonly callId: string;
  readonly afterHours: true;
  readonly urgency: 'routine' | 'urgent' | 'emergency';
  readonly pagedOnCall: boolean;
  readonly contextPackageRef: string | null;
  readonly workItemId: string;
  readonly synthetic: true;
}

export function triageAfterHoursVoicemail(input: {
  readonly session: CallSession;
  readonly afterHours: boolean;
  readonly transcriptRef: string | null;
  readonly urgency: UrgencyScreenDouble;
  readonly onCall: OnCallContextDouble;
}): VoicemailTriage {
  if (input.session.state !== 'voicemail') {
    throw new VoiceError('triage requires a voicemail call');
  }
  if (input.afterHours !== true) {
    throw new VoiceError('this rail is after-hours only');
  }
  const screen = input.urgency.screen({
    tenantId: input.session.tenantId,
    callId: input.session.callId,
    transcriptRef: input.transcriptRef,
  });
  const failSafeUrgent = input.transcriptRef === null || input.transcriptRef.trim() === '';
  const urgency = failSafeUrgent && screen.urgency === 'routine' ? 'urgent' : screen.urgency;
  const paged = urgency === 'urgent' || urgency === 'emergency';
  const context = paged
    ? input.onCall.page({
        tenantId: input.session.tenantId,
        callId: input.session.callId,
        urgency: urgency === 'emergency' ? 'emergency' : 'urgent',
      })
    : { contextPackageRef: null, workItemId: screen.workItemId };
  return {
    tenantId: input.session.tenantId,
    callId: input.session.callId,
    afterHours: true,
    urgency,
    pagedOnCall: paged,
    contextPackageRef: context.contextPackageRef,
    workItemId: context.workItemId,
    synthetic: true,
  };
}
