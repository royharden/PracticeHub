import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import {
  answerCall,
  applyRecordingDecision,
  completeCall,
  openCall,
  sendToVoicemail,
} from './call-workflow.js';
import { afterHoursUnansweredGreeting } from './greeting.js';
import { playRecording } from './playback.js';
import { legalHoldRegistryDoubleV1 } from './testing/legal-hold-registry-double-v1.js';
import { wp011LocationDoubleV1 } from './testing/wp011-location-double-v1.js';
import { wp023OnCallDoubleV1 } from './testing/wp023-oncall-double-v1.js';
import { wp045UrgencyDoubleV1 } from './testing/wp045-urgency-double-v1.js';
import type { VoiceParty } from './types.js';
import { VoiceError } from './types.js';
import { triageAfterHoursVoicemail } from './voicemail-triage.js';

const directory = fileURLToPath(new URL('../fixtures', import.meta.url));

const granted: readonly VoiceParty[] = [
  { partyId: 'p1', role: 'caller', consent: 'granted' },
  { partyId: 'p2', role: 'callee', consent: 'granted' },
];
const refused: readonly VoiceParty[] = [
  { partyId: 'p1', role: 'caller', consent: 'granted' },
  { partyId: 'p2', role: 'callee', consent: 'refused' },
];
const uncertain: readonly VoiceParty[] = [
  { partyId: 'p1', role: 'caller', consent: 'granted' },
  { partyId: 'p2', role: 'callee', consent: 'uncertain' },
];

interface VoiceFixtureCase {
  readonly name: string;
  readonly op: string;
  readonly expectOutcome?: string;
  readonly expectWorkflow?: boolean;
  readonly expectTranscript?: boolean;
  readonly expectPlayback?: boolean;
  readonly expectState?: string;
  readonly expectPaged?: boolean;
  readonly expectError?: string;
  readonly expect911?: boolean;
}

const fixtureOps = [
  'record-with-all-party-consent',
  'unknown-location-all-party',
  'refuse-all-party',
  'complete-unrecorded',
  'after-hours-911-greeting',
  'after-hours-routine',
  'in-hours-rejected',
  'missing-transcript-fail-safe',
  'legal-hold-retain',
  'quarantine-without-consent',
  'uncertain-consent-human-verify',
] as const;

function answered(callId: string) {
  return answerCall(
    openCall({ tenantId: 'northwind-synthetic', callId, direction: 'inbound', synthetic: true }),
  );
}

function decide(
  callId: string,
  parties: readonly VoiceParty[],
  bytes: boolean,
  jurisdiction = 'NV',
  holds: readonly string[] = [],
) {
  return applyRecordingDecision(answered(callId), {
    parties,
    recordingBytesPresent: bytes,
    location: wp011LocationDoubleV1(),
    jurisdiction,
    legalHoldRegistry: legalHoldRegistryDoubleV1(holds),
  });
}

function runCase(fixtureCase: VoiceFixtureCase): void {
  switch (fixtureCase.op) {
    case 'record-with-all-party-consent':
    case 'unknown-location-all-party': {
      const session = decide(
        'c-happy',
        granted,
        false,
        fixtureCase.op === 'unknown-location-all-party' ? 'unknown' : 'NV',
      );
      expect(session.recording?.rule).toBe('all-party');
      expect(session.recording?.outcome).toBe(fixtureCase.expectOutcome);
      return;
    }
    case 'refuse-all-party': {
      const session = decide('c-refuse', refused, false);
      expect(session.recording?.outcome).toBe(fixtureCase.expectOutcome);
      expect(session.recording?.workflowPermitted).toBe(true);
      expect(session.recording?.transcriptPermitted).toBe(false);
      return;
    }
    case 'complete-unrecorded': {
      const session = completeCall(decide('c-complete', refused, false));
      expect(session.state).toBe(fixtureCase.expectState);
      expect(session.recording?.outcome).toBe(fixtureCase.expectOutcome);
      return;
    }
    case 'after-hours-911-greeting': {
      const greeting = afterHoursUnansweredGreeting();
      expect(greeting.includes911).toBe(true);
      expect(greeting.text.toLowerCase()).toContain('911');
      const session = sendToVoicemail(answered('c-vm'));
      const triage = triageAfterHoursVoicemail({
        session,
        afterHours: true,
        transcriptRef: 'synthetic-transcript:urgent',
        urgency: wp045UrgencyDoubleV1('urgent'),
        onCall: wp023OnCallDoubleV1(),
      });
      expect(triage.pagedOnCall).toBe(true);
      return;
    }
    case 'after-hours-routine': {
      const session = sendToVoicemail(answered('c-vm'));
      const triage = triageAfterHoursVoicemail({
        session,
        afterHours: true,
        transcriptRef: 'synthetic-transcript:routine',
        urgency: wp045UrgencyDoubleV1('routine'),
        onCall: wp023OnCallDoubleV1(),
      });
      expect(triage.pagedOnCall).toBe(fixtureCase.expectPaged);
      return;
    }
    case 'missing-transcript-fail-safe': {
      const session = sendToVoicemail(answered('c-vm-null'));
      const triage = triageAfterHoursVoicemail({
        session,
        afterHours: true,
        transcriptRef: null,
        urgency: wp045UrgencyDoubleV1('routine'),
        onCall: wp023OnCallDoubleV1(),
      });
      expect(triage.urgency).toBe('urgent');
      expect(triage.pagedOnCall).toBe(true);
      return;
    }
    case 'in-hours-rejected': {
      const session = sendToVoicemail(answered('c-in-hours'));
      expect(() =>
        triageAfterHoursVoicemail({
          session,
          afterHours: false,
          transcriptRef: 'x',
          urgency: wp045UrgencyDoubleV1('urgent'),
          onCall: wp023OnCallDoubleV1(),
        }),
      ).toThrow(fixtureCase.expectError);
      return;
    }
    case 'legal-hold-retain': {
      const session = decide('held-1', refused, true, 'NV', ['held-1']);
      const recording = session.recording;
      expect(recording).toBeTruthy();
      if (recording === null) {
        throw new VoiceError('expected recording decision');
      }
      expect(recording.outcome).toBe(fixtureCase.expectOutcome);
      expect(() => playRecording(recording)).toThrow(VoiceError);
      return;
    }
    case 'quarantine-without-consent': {
      const session = decide('c-q', refused, true);
      const recording = session.recording;
      expect(recording).toBeTruthy();
      if (recording === null) {
        throw new VoiceError('expected recording decision');
      }
      expect(recording.outcome).toBe(fixtureCase.expectOutcome);
      expect(recording.playbackPermitted).toBe(false);
      expect(() => playRecording(recording)).toThrow(VoiceError);
      return;
    }
    case 'uncertain-consent-human-verify': {
      const session = decide('c-u', uncertain, true);
      expect(session.recording?.outcome).toBe(fixtureCase.expectOutcome);
      expect(session.recording?.playbackPermitted).toBe(false);
      return;
    }
    default:
      throw new Error(`unknown op ${fixtureCase.op}`);
  }
}

for (const requirementId of ['REQ-VOICE-002', 'REQ-VOICE-012', 'REQ-VOICE-013']) {
  describe(`${requirementId} fixture pack`, () => {
    const pack = loadRequirementFixturePack(directory, requirementId);
    it('carries the complete four-class floor and a closed operation vocabulary', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as { cases: readonly VoiceFixtureCase[] };
        expect(fixture.cases.length).toBeGreaterThan(0);
        for (const fixtureCase of fixture.cases) expect(fixtureOps).toContain(fixtureCase.op);
      }
    });
    for (const fixtureClass of requiredFixtureClasses) {
      const fixture = pack.fixtures[fixtureClass] as { cases: readonly VoiceFixtureCase[] };
      for (const fixtureCase of fixture.cases) {
        it(`${fixtureClass}: ${fixtureCase.name}`, () => runCase(fixtureCase));
      }
    }
  });
}
