/**
 * WP-071 hardening H-19 (NR-156, NR-157). Each regression fails on candidates/D54-WP-072-a3.
 */
import type { CanSendInput, ConsentStateRow } from '@practicehub/consent';
import { describe, expect, it } from 'vitest';

import {
  deliverToMember,
  DeliverabilityPosture,
  SuppressionStore,
  type MemberChannelDirectory,
} from './deliverability.js';
import { runJourney } from './journey.js';
import type { Wp070CrmMember } from './placeholder.js';

const tenantA = 'tenant-synthetic-a';
const member: Wp070CrmMember = {
  placeholderFor: 'WP-070',
  memberId: 'member-a',
  tenantId: tenantA,
  synthetic: true,
};

function consent(channel: 'email' | 'sms' = 'email'): CanSendInput {
  const state: ConsentStateRow = {
    tenantId: tenantA,
    personRef: 'member-a',
    scopeKey: `communication:${channel}:marketing`,
    scopeType: 'communication',
    channel,
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
    channel,
    purpose: 'marketing',
    state,
    urgency: 'routine',
    asOf: '2026-09-25T15:00:00Z',
    actorRef: 'marketer-synthetic-1',
    occurredAt: '2026-09-25T15:00:00Z',
  };
}

const campaign = { campaignId: 'camp-a', segmentId: 'segment-core' };
const compliantTemplate = {
  templateId: 'tmpl-2',
  body: 'Synthetic panel reminder. Unsubscribe: {{unsubscribe_url}} | {{postal_address}}',
};
const bareTemplate = { templateId: 'tmpl-1', body: 'Synthetic panel reminder' };
const segment = {
  rule: { segmentId: 'segment-core', criteria: { plan_tier: ['core'] } },
  profile: { plan_tier: 'core' },
};
const canSpam = {
  unsubscribeUrl: 'https://example.test/u/synthetic',
  postalAddress: '1 Synthetic Way, Reno NV',
};

describe('NR-156: a journey that names a segment must check membership', () => {
  it('refuses a named-segment campaign when no segment rule and profile are supplied', () => {
    const run = runJourney({
      member,
      campaign,
      template: compliantTemplate,
      consent: consent(),
      canSpam,
    });
    expect(run.refusal).toBe('segment-required');
    expect(run.send).toBeNull();
  });
});

describe('NR-157: CAN-SPAM rendering is on the send path', () => {
  it('refuses a marketing send with no CAN-SPAM context', () => {
    const run = runJourney({
      member,
      campaign,
      template: compliantTemplate,
      consent: consent(),
      segment,
    });
    expect(run.refusal).toBe('can-spam-missing');
    expect(run.send).toBeNull();
  });

  it('refuses a template without the unsubscribe and postal tokens', () => {
    const run = runJourney({
      member,
      campaign,
      template: bareTemplate,
      consent: consent(),
      segment,
      canSpam,
    });
    expect(run.refusal).toBe('can-spam-missing');
    expect(run.send).toBeNull();
  });

  it('sends the rendered body, carrying the unsubscribe link and postal address', () => {
    const run = runJourney({
      member,
      campaign,
      template: compliantTemplate,
      consent: consent(),
      segment,
      canSpam,
    });
    expect(run.send?.body).toBe(
      'Synthetic panel reminder. Unsubscribe: https://example.test/u/synthetic | 1 Synthetic Way, Reno NV',
    );
  });
});

describe('H-19 on the delivery path (deliverToMember)', () => {
  const directory: MemberChannelDirectory = { addressOf: () => 'a@example.test' };

  it('a delivery without a segment is refused and does not count as a send', () => {
    const posture = new DeliverabilityPosture();
    const result = deliverToMember({
      member,
      senderId: 'sender-1',
      campaign,
      template: compliantTemplate,
      consent: consent(),
      directory,
      store: new SuppressionStore(),
      posture,
      partitionFields: ['region'],
      canSpam,
    });
    expect(result.send).toBeNull();
    expect(result.run?.refusal).toBe('segment-required');
    expect(posture.get(tenantA, 'sender-1').sends).toBe(0);
  });

  it('keeps the WP-072 a3 channel-bound consent', () => {
    const result = deliverToMember({
      member,
      senderId: 'sender-1',
      campaign,
      template: compliantTemplate,
      consent: consent('sms'),
      directory,
      store: new SuppressionStore(),
      posture: new DeliverabilityPosture(),
      partitionFields: ['region'],
      segment,
      canSpam,
    });
    expect(result.blocked).toBe('consent-channel-mismatch');
  });
});
