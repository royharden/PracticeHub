import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { CanSendInput, ConsentStateRow } from '@practicehub/consent';
import { describe, expect, it } from 'vitest';

import { attribute } from './attribution.js';
import type { AttributionRow, AttributionTotals } from './attribution.js';
import { canSend } from './cansend.js';
import { runJourney } from './journey.js';
import type { Wp070CrmMember } from './placeholder.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function member(): Wp070CrmMember {
  return JSON.parse(readFileSync(`${root}fixtures/WP-070.member.json`, 'utf8')) as Wp070CrmMember;
}

function consent(purpose: CanSendInput['purpose'], state: ConsentStateRow | null): CanSendInput {
  return {
    tenantId: 'tenant-synthetic-a',
    personRef: 'member-synthetic-1',
    channel: 'email',
    purpose,
    state,
    urgency: 'routine',
    asOf: '2026-09-25T15:00:00Z',
    actorRef: 'marketer-synthetic-1',
    occurredAt: '2026-09-25T15:00:00Z',
  };
}

function optedIn(): ConsentStateRow {
  return {
    tenantId: 'tenant-synthetic-a',
    personRef: 'member-synthetic-1',
    scopeKey: 'communication:email:marketing',
    scopeType: 'communication',
    channel: 'email',
    purpose: 'marketing',
    currentState: 'opted_in',
    effectiveAt: '2026-09-01T00:00:00Z',
    lastEventId: 'evt-marketing-1',
    quietHoursTz: 'America/Chicago',
    jurisdiction: 'NV',
    synthetic: true,
  };
}

describe('WP-071 marketing', () => {
  it('canSend refuses a non-marketing purpose', () => {
    const decision = canSend(consent('treatment', null));
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('purpose-not-marketing');
    expect(decision.consent).toBeNull();
  });

  it('a journey runs from entry to a recorded send', () => {
    const run = runJourney({
      member: member(),
      campaign: { campaignId: 'camp-a', segmentId: 'segment-core' },
      template: {
        templateId: 'tmpl-1',
        body: 'Synthetic panel reminder {{unsubscribe_url}} {{postal_address}}',
      },
      consent: consent('marketing', optedIn()),
      // H-19: a named-segment campaign needs its segment, and a marketing send needs CAN-SPAM context.
      segment: {
        rule: { segmentId: 'segment-core', criteria: { plan_tier: ['core'] } },
        profile: { plan_tier: 'core' },
      },
      canSpam: {
        unsubscribeUrl: 'https://example.test/u/synthetic',
        postalAddress: '1 Synthetic Way, Reno NV',
      },
    });
    expect(run.steps).toEqual(['entered', 'rendered', 'sent']);
    expect(run.send?.purpose).toBe('marketing');
    expect(run.send?.memberId).toBe('member-synthetic-1');
    // The sent body is the CAN-SPAM rendering of the template.
    expect(run.send?.body).toBe(
      'Synthetic panel reminder https://example.test/u/synthetic 1 Synthetic Way, Reno NV',
    );
  });

  it('attribution math matches the fixture totals', () => {
    const fixture = JSON.parse(readFileSync(`${root}fixtures/WP-071.attribution.json`, 'utf8')) as {
      rows: readonly AttributionRow[];
      totals: AttributionTotals;
    };
    expect(attribute(fixture.rows)).toEqual(fixture.totals);
  });
});
