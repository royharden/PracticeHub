import { describe, expect, it } from 'vitest';

import {
  answerCall,
  applyRecordingDecision,
  completeCall,
  failOpenToCallback,
  openCall,
} from './call-workflow.js';
import { legalHoldRegistryDoubleV1 } from './testing/legal-hold-registry-double-v1.js';
import { wp011LocationDoubleV1 } from './testing/wp011-location-double-v1.js';

describe('call workflow', () => {
  it('completes an inbound call after an unrecorded-service decision', () => {
    const session = completeCall(
      applyRecordingDecision(
        answerCall(
          openCall({
            tenantId: 't1',
            callId: 'c1',
            direction: 'inbound',
            synthetic: true,
          }),
        ),
        {
          parties: [
            { partyId: 'p1', role: 'caller', consent: 'granted' },
            { partyId: 'p2', role: 'callee', consent: 'refused' },
          ],
          recordingBytesPresent: false,
          location: wp011LocationDoubleV1(),
          jurisdiction: 'NV',
          legalHoldRegistry: legalHoldRegistryDoubleV1(),
        },
      ),
    );
    expect(session.state).toBe('completed');
    expect(session.recording?.outcome).toBe('unrecorded-service');
    expect(session.recording?.playbackPermitted).toBe(false);
  });

  it('fails open to a callback WorkItem', () => {
    const session = failOpenToCallback(
      openCall({ tenantId: 't1', callId: 'c2', direction: 'inbound', synthetic: true }),
      'wi:callback:c2',
    );
    expect(session.state).toBe('failed-open-to-callback');
    expect(session.workItemId).toBe('wi:callback:c2');
  });
});
