import type { CanSendInput, ConsentStateRow } from '@practicehub/consent';
import { describe, expect, it } from 'vitest';

import {
  deliverToMember,
  DeliverabilityPosture,
  SuppressionStore,
  type MemberChannelDirectory,
} from './deliverability.js';
import type { Wp070CrmMember } from './placeholder.js';

const tenantA = 'tenant-synthetic-a';
const member: Wp070CrmMember = {
  placeholderFor: 'WP-070',
  memberId: 'member-a',
  tenantId: tenantA,
  synthetic: true,
};
const directory: MemberChannelDirectory = {
  addressOf: (tenantId, memberId) =>
    tenantId === tenantA && memberId === 'member-a' ? 'member-a@example.test' : undefined,
};

function consent(requestChannel: 'email' | 'sms', stateChannel: 'email' | 'sms'): CanSendInput {
  const state: ConsentStateRow = {
    tenantId: tenantA,
    personRef: 'member-a',
    scopeKey: `communication:${stateChannel}:marketing`,
    scopeType: 'communication',
    channel: stateChannel,
    purpose: 'marketing',
    currentState: 'opted_in',
    effectiveAt: '2026-09-01T00:00:00Z',
    lastEventId: 'evt-marketing-1',
    quietHoursTz: 'America/Chicago',
    jurisdiction: 'NV',
    synthetic: true,
  };
  return {
    tenantId: tenantA,
    personRef: 'member-a',
    channel: requestChannel,
    purpose: 'marketing',
    state,
    urgency: 'routine',
    asOf: '2026-09-25T15:00:00Z',
    actorRef: 'marketer-synthetic-1',
    occurredAt: '2026-09-25T15:00:00Z',
  };
}

function send(input: CanSendInput) {
  return deliverToMember({
    member,
    senderId: 'sender-marketing-1',
    campaign: { campaignId: 'camp-a', segmentId: 'segment-core' },
    template: {
      templateId: 'tmpl-1',
      body: 'Synthetic panel reminder {{unsubscribe_url}} {{postal_address}}',
    },
    consent: input,
    directory,
    store: new SuppressionStore(),
    posture: new DeliverabilityPosture(),
    partitionFields: ['region'],
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
}

describe('WP-072 targeted fix R1: email delivery requires email consent', () => {
  it('an SMS-only opt-in does not authorize a marketing email (pass-2 probe CHANNEL)', () => {
    const result = send(consent('sms', 'sms'));
    expect(result.blocked).toBe('consent-channel-mismatch');
    expect(result.send).toBeNull();
  });

  it('an email request backed by an SMS consent row is refused', () => {
    const result = send(consent('email', 'sms'));
    expect(result.blocked).toBe('consent-channel-mismatch');
    expect(result.send).toBeNull();
  });

  it("an email opt-in still sends to the member's own address", () => {
    const result = send(consent('email', 'email'));
    expect(result.blocked).toBeNull();
    expect(result.send?.address).toBe('member-a@example.test');
  });
});
