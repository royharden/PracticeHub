import type { CanSendInput, ConsentStateRow } from '@practicehub/consent';
import { describe, expect, it } from 'vitest';

import { attribute } from './attribution.js';
import { runJourney } from './journey.js';
import type { Wp070CrmMember } from './placeholder.js';
import { memberInSegment, renderCanSpamTemplate } from './segments.js';

const tenantA = 'tenant-synthetic-a';

const member = (memberId: string, tenantId = tenantA): Wp070CrmMember => ({
  placeholderFor: 'WP-070',
  memberId,
  tenantId,
  synthetic: true,
});

function optedIn(personRef: string, tenantId = tenantA): ConsentStateRow {
  return {
    tenantId,
    personRef,
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

function consent(
  personRef: string,
  tenantId = tenantA,
  state: ConsentStateRow | null = optedIn(personRef, tenantId),
): CanSendInput {
  return {
    tenantId,
    personRef,
    channel: 'email',
    purpose: 'marketing',
    state,
    urgency: 'routine',
    asOf: '2026-09-25T15:00:00Z',
    actorRef: 'marketer-synthetic-1',
    occurredAt: '2026-09-25T15:00:00Z',
  };
}

const campaign = { campaignId: 'camp-a', segmentId: 'segment-core' };
const template = {
  templateId: 'tmpl-1',
  body: 'Synthetic panel reminder {{unsubscribe_url}} {{postal_address}}',
};
// H-19: a named-segment campaign needs its segment, and a marketing send needs CAN-SPAM context.
const segment = {
  rule: { segmentId: 'segment-core', criteria: { plan_tier: ['core'] } },
  profile: { plan_tier: 'core' },
};
const canSpam = {
  unsubscribeUrl: 'https://example.test/u/synthetic',
  postalAddress: '1 Synthetic Way, Reno NV',
};

describe('WP-071 rework F1: consent is bound to the recipient', () => {
  it("refuses a send on another person's opt-in", () => {
    const run = runJourney({
      member: member('member-a'),
      campaign,
      template,
      segment,
      canSpam,
      consent: consent('member-b'),
    });
    expect(run.send).toBeNull();
    expect(run.refusal).toBe('consent-recipient-mismatch');
  });

  it('refuses a send to a member of another tenant', () => {
    const run = runJourney({
      member: member('member-a', 'tenant-synthetic-b'),
      campaign,
      template,
      segment,
      canSpam,
      consent: consent('member-a'),
    });
    expect(run.send).toBeNull();
    expect(run.refusal).toBe('consent-recipient-mismatch');
  });

  it('refuses when the folded consent row belongs to someone else even if the request names the recipient', () => {
    const run = runJourney({
      member: member('member-a'),
      campaign,
      template,
      segment,
      canSpam,
      consent: consent('member-a', tenantA, optedIn('member-b')),
    });
    expect(run.send).toBeNull();
    expect(run.refusal).toBe('consent-recipient-mismatch');
  });

  it("still sends on the recipient's own opt-in", () => {
    const run = runJourney({
      member: member('member-a'),
      campaign,
      template,
      segment,
      canSpam,
      consent: consent('member-a'),
    });
    expect(run.send?.memberId).toBe('member-a');
    expect(run.refusal).toBeUndefined();
  });
});

describe('WP-071 rework F2: segments and CAN-SPAM templates', () => {
  const rule = {
    segmentId: 'segment-core',
    criteria: { plan_tier: ['core'], age_band: ['40-49', '50-59'] },
  };

  it('evaluates segment membership over demographic fields only, failing closed', () => {
    expect(memberInSegment({ plan_tier: 'core', age_band: '40-49' }, rule)).toBe(true);
    expect(memberInSegment({ plan_tier: 'core', age_band: '30-39' }, rule)).toBe(false);
    expect(memberInSegment({ plan_tier: 'core' }, rule)).toBe(false);
    expect(memberInSegment({ plan_tier: 'core' }, { segmentId: 's', criteria: {} })).toBe(false);
    expect(
      memberInSegment(
        { plan_tier: 'core' },
        { segmentId: 's', criteria: { email: ['x'] } as never },
      ),
    ).toBe(false);
  });

  it('a journey with a segment refuses non-members and mismatched segments', () => {
    const base = {
      member: member('member-a'),
      campaign,
      template,
      segment,
      canSpam,
      consent: consent('member-a'),
    };
    expect(
      runJourney({
        ...base,
        segment: { rule, profile: { plan_tier: 'premier', age_band: '40-49' } },
      }).refusal,
    ).toBe('not-in-segment');
    expect(
      runJourney({
        ...base,
        segment: {
          rule: { ...rule, segmentId: 'other' },
          profile: { plan_tier: 'core', age_band: '40-49' },
        },
      }).refusal,
    ).toBe('segment-mismatch');
    expect(
      runJourney({ ...base, segment: { rule, profile: { plan_tier: 'core', age_band: '40-49' } } })
        .send,
    ).not.toBeNull();
  });

  it('renders a template only when it carries the unsubscribe link and postal address', () => {
    const context = {
      unsubscribeUrl: 'https://example.test/u/abc',
      postalAddress: '1 Synthetic Way, Reno NV',
    };
    expect(renderCanSpamTemplate('Hi. {{unsubscribe_url}} {{postal_address}}', context)).toBe(
      'Hi. https://example.test/u/abc 1 Synthetic Way, Reno NV',
    );
    expect(() => renderCanSpamTemplate('Hi. {{postal_address}}', context)).toThrow(/unsubscribe/);
    expect(() =>
      renderCanSpamTemplate('Hi. {{unsubscribe_url}} {{postal_address}}', {
        ...context,
        unsubscribeUrl: 'http://x',
      }),
    ).toThrow();
  });
});

describe('WP-071 rework F3: attribution input validation', () => {
  it('rejects fractional counts, duplicate campaigns and conversions above sends', () => {
    expect(() => attribute([{ campaignId: 'a', sends: 1.5, conversions: 0 }])).toThrow(
      /whole numbers/,
    );
    expect(() =>
      attribute([
        { campaignId: 'a', sends: 2, conversions: 1 },
        { campaignId: 'a', sends: 1, conversions: 0 },
      ]),
    ).toThrow(/more than once/);
    expect(() => attribute([{ campaignId: 'a', sends: 1, conversions: 2 }])).toThrow(
      /not above sends/,
    );
    expect(
      attribute([
        { campaignId: 'a', sends: 4, conversions: 1 },
        { campaignId: 'b', sends: 6, conversions: 3 },
      ]),
    ).toEqual({
      sends: 10,
      conversions: 4,
      conversionRateBps: 4000,
    });
  });
});
