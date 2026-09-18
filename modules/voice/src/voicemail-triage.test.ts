import { describe, expect, it } from 'vitest';

import { answerCall, openCall, sendToVoicemail } from './call-workflow.js';
import { wp023OnCallDoubleV1 } from './testing/wp023-oncall-double-v1.js';
import { wp045UrgencyDoubleV1 } from './testing/wp045-urgency-double-v1.js';
import { triageAfterHoursVoicemail } from './voicemail-triage.js';

describe('triageAfterHoursVoicemail', () => {
  it('pages on-call for urgent after-hours voicemail via WP-023 double', () => {
    const session = sendToVoicemail(
      answerCall(openCall({ tenantId: 't1', callId: 'c9', direction: 'inbound', synthetic: true })),
    );
    const triage = triageAfterHoursVoicemail({
      session,
      afterHours: true,
      transcriptRef: 'synthetic-transcript:urgent',
      urgency: wp045UrgencyDoubleV1('urgent'),
      onCall: wp023OnCallDoubleV1(),
    });
    expect(triage.pagedOnCall).toBe(true);
    expect(triage.contextPackageRef).toContain('ctx:oncall:');
    expect(triage.workItemId).toBe('wi:page:c9');
  });

  it('fail-safe pages when transcription is missing even if the double says routine', () => {
    const session = sendToVoicemail(
      answerCall(
        openCall({ tenantId: 't1', callId: 'c-null', direction: 'inbound', synthetic: true }),
      ),
    );
    const triage = triageAfterHoursVoicemail({
      session,
      afterHours: true,
      transcriptRef: null,
      urgency: wp045UrgencyDoubleV1('routine'),
      onCall: wp023OnCallDoubleV1(),
    });
    expect(triage.urgency).toBe('urgent');
    expect(triage.pagedOnCall).toBe(true);
  });

  it('does not page on-call for routine after-hours voicemail', () => {
    const session = sendToVoicemail(
      answerCall(openCall({ tenantId: 't1', callId: 'c8', direction: 'inbound', synthetic: true })),
    );
    const triage = triageAfterHoursVoicemail({
      session,
      afterHours: true,
      transcriptRef: 'synthetic-transcript:routine',
      urgency: wp045UrgencyDoubleV1('routine'),
      onCall: wp023OnCallDoubleV1(),
    });
    expect(triage.pagedOnCall).toBe(false);
    expect(triage.contextPackageRef).toBeNull();
  });
});
