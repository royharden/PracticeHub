import { describe, expect, it } from 'vitest';

import { decideRecording, schedulePurge } from './recording-consent.js';
import { legalHoldRegistryDoubleV1 } from './testing/legal-hold-registry-double-v1.js';
import { wp011LocationDoubleV1 } from './testing/wp011-location-double-v1.js';
import { VoiceError } from './types.js';

const granted = [
  { partyId: 'p1', role: 'caller' as const, consent: 'granted' as const },
  { partyId: 'p2', role: 'callee' as const, consent: 'granted' as const },
];
const refused = [
  { partyId: 'p1', role: 'caller' as const, consent: 'granted' as const },
  { partyId: 'p2', role: 'callee' as const, consent: 'refused' as const },
];
const uncertain = [
  { partyId: 'p1', role: 'caller' as const, consent: 'granted' as const },
  { partyId: 'p2', role: 'callee' as const, consent: 'uncertain' as const },
];

const base = {
  tenantId: 't1',
  callId: 'c1',
  location: wp011LocationDoubleV1(),
  jurisdiction: 'NV',
  legalHoldRegistry: legalHoldRegistryDoubleV1(),
  synthetic: true as const,
};

describe('decideRecording', () => {
  it('permits recording only when every live party granted all-party consent', () => {
    const decision = decideRecording({ ...base, parties: granted, recordingBytesPresent: false });
    expect(decision.outcome).toBe('recording-permitted');
    expect(decision.playbackPermitted).toBe(true);
  });

  it('keeps unrecorded workflow when a party refuses and no bytes exist', () => {
    const decision = decideRecording({ ...base, parties: refused, recordingBytesPresent: false });
    expect(decision.outcome).toBe('unrecorded-service');
    expect(decision.workflowPermitted).toBe(true);
    expect(decision.transcriptPermitted).toBe(false);
    expect(decision.playbackPermitted).toBe(false);
  });

  it('quarantines bytes captured without all-party grant and blocks playback', () => {
    const decision = decideRecording({ ...base, parties: refused, recordingBytesPresent: true });
    expect(decision.outcome).toBe('quarantined');
    expect(decision.playbackPermitted).toBe(false);
  });

  it('holds uncertain consent for human verification instead of purge', () => {
    const decision = decideRecording({ ...base, parties: uncertain, recordingBytesPresent: true });
    expect(decision.outcome).toBe('hold-human-verify');
    expect(decision.playbackPermitted).toBe(false);
  });

  it('checks the legal-hold registry before purge and retain wins', () => {
    const quarantined = decideRecording({
      ...base,
      callId: 'held-1',
      parties: refused,
      recordingBytesPresent: true,
      legalHoldRegistry: legalHoldRegistryDoubleV1(['held-1']),
    });
    expect(quarantined.outcome).toBe('legal-hold-retain');
  });

  it('lets a later hold win over a scheduled purge', () => {
    const quarantined = decideRecording({ ...base, parties: refused, recordingBytesPresent: true });
    const held = schedulePurge({ ...quarantined, legalHold: true });
    expect(held.outcome).toBe('legal-hold-retain');
  });

  it('uses all-party even for FL/MN/unknown and pending counsel', () => {
    for (const jurisdiction of ['FL', 'MN', 'unknown', '']) {
      const decision = decideRecording({
        ...base,
        jurisdiction,
        location: wp011LocationDoubleV1(true),
        parties: granted,
        recordingBytesPresent: false,
      });
      expect(decision.rule).toBe('all-party');
    }
  });

  it('rejects non-synthetic facts', () => {
    expect(() =>
      decideRecording({
        ...base,
        parties: granted,
        recordingBytesPresent: false,
        synthetic: false,
      }),
    ).toThrow(VoiceError);
  });
});
