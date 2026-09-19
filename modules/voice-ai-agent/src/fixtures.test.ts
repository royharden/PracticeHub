import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { type CanSendState } from './bindings/wp018-cansend-double-v1.js';
import { type SponsorOutboundPolicy } from './consent-gate.js';
import { VoiceAgentError } from './contracts.js';
import { ConversationRelaySession } from './relay-session.js';

type FixtureClass = 'HAPPY' | 'BOUNDARY' | 'FAILURE' | 'RECOVERY';

interface FixturePack {
  readonly requirementId: 'REQ-VOICE-001';
  readonly fixtureClass: FixtureClass;
  readonly synthetic: true;
  readonly direction: 'inbound' | 'outbound';
  readonly consentState: { readonly currentState: CanSendState } | null;
  readonly ledgerAvailable: boolean;
  readonly sponsorPolicy?: SponsorOutboundPolicy;
  readonly expectBlocked: boolean;
}

const directory = dirname(fileURLToPath(import.meta.url));

function loadPack(fixtureClass: FixtureClass): FixturePack {
  const path = resolve(directory, `../fixtures/REQ-VOICE-001.${fixtureClass}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FixturePack>;
  if (
    raw.requirementId !== 'REQ-VOICE-001' ||
    raw.fixtureClass !== fixtureClass ||
    raw.synthetic !== true
  ) {
    throw new Error(`INVALID_WP047_FIXTURE:${fixtureClass}`);
  }
  return raw as FixturePack;
}

function run(pack: FixturePack): void {
  const start = (): ConversationRelaySession =>
    new ConversationRelaySession({
      sessionId: pack.fixtureClass,
      direction: pack.direction,
      purpose: 'treatment',
      consentState: pack.consentState,
      ledgerAvailable: pack.ledgerAvailable,
      authenticated: true,
      afterHours: false,
      synthetic: true,
      ...(pack.sponsorPolicy !== undefined ? { sponsorPolicy: pack.sponsorPolicy } : {}),
    });
  if (pack.expectBlocked) {
    expect(start).toThrow(VoiceAgentError);
    return;
  }
  expect(start().snapshot().direction).toBe(pack.direction);
}

describe('REQ-VOICE-001 fixtures', () => {
  it('HAPPY inbound allowed without outbound policy', () => {
    run(loadPack('HAPPY'));
  });
  it('BOUNDARY outbound blocked by default sponsor policy', () => {
    run(loadPack('BOUNDARY'));
  });
  it('FAILURE outbound with opted_in but ledger unavailable', () => {
    run(loadPack('FAILURE'));
  });
  it('RECOVERY outbound after recorded sponsor enable + opted_in', () => {
    run(loadPack('RECOVERY'));
  });
});
