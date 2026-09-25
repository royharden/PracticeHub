import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { CanSendInput, ConsentStateRow } from '@practicehub/consent';
import { describe, expect, it } from 'vitest';

import { applyBounce, deliver } from './suppression.js';
import type { Wp070CrmMember } from './placeholder.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function member(memberId: string): Wp070CrmMember {
  const parsed = JSON.parse(
    readFileSync(`${root}fixtures/WP-070.member.json`, 'utf8'),
  ) as Wp070CrmMember;
  return { ...parsed, memberId };
}

function optedIn(personRef: string): ConsentStateRow {
  return {
    tenantId: 'tenant-synthetic-a',
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

function consent(personRef: string): CanSendInput {
  return {
    tenantId: 'tenant-synthetic-a',
    personRef,
    channel: 'email',
    purpose: 'marketing',
    state: optedIn(personRef),
    urgency: 'routine',
    asOf: '2026-09-25T15:00:00Z',
    actorRef: 'marketer-synthetic-1',
    occurredAt: '2026-09-25T15:00:00Z',
  };
}

const campaign = { campaignId: 'camp-a', segmentId: 'segment-core' };
const template = { templateId: 'tmpl-1', body: 'Synthetic panel reminder' };

describe('WP-072 marketing suppression', () => {
  it('a partition-fuzz case fails closed and does not send', () => {
    const fuzzed = deliver({
      member: member('member-synthetic-1'),
      campaign,
      template,
      consent: consent('member-synthetic-1'),
      address: 'member-synthetic-1@example.test',
      suppressions: [],
      partitionFields: ['memberId'],
    });
    expect(fuzzed.blocked).toBe('partition');
    expect(fuzzed.run).toBeNull();
    const demographic = deliver({
      member: member('member-synthetic-1'),
      campaign,
      template,
      consent: consent('member-synthetic-1'),
      address: 'member-synthetic-1@example.test',
      suppressions: [],
      partitionFields: ['age_band'],
    });
    expect(demographic.blocked).toBeNull();
    expect(demographic.run?.send).not.toBeNull();
  });

  it('a suppressed address produces no send', () => {
    const blocked = deliver({
      member: member('member-synthetic-1'),
      campaign,
      template,
      consent: consent('member-synthetic-1'),
      address: 'member-synthetic-1@example.test',
      suppressions: [{ address: 'Member-Synthetic-1@example.test' }],
      partitionFields: ['region'],
    });
    expect(blocked.blocked).toBe('suppressed');
    expect(blocked.run).toBeNull();
  });

  it('a bounce does not retarget another person in the same household', () => {
    const first = { member: member('member-synthetic-1'), address: 'one@example.test' };
    const second = { member: member('member-synthetic-2'), address: 'two@example.test' };
    const household = [first, second];
    const bounce = applyBounce({
      bouncedMemberId: 'member-synthetic-1',
      address: 'one@example.test',
      household,
    });
    expect(bounce.retargetMemberId).toBeNull();
    expect(household.map((row) => row.member.memberId)).toEqual([
      'member-synthetic-1',
      'member-synthetic-2',
    ]);
    const retargetAttempt = deliver({
      member: second.member,
      campaign,
      template,
      consent: consent('member-synthetic-2'),
      address: bounce.suppressedAddress,
      suppressions: [{ address: bounce.suppressedAddress }],
      partitionFields: ['plan_tier'],
    });
    expect(retargetAttempt.run).toBeNull();
    const otherAddress = deliver({
      member: second.member,
      campaign,
      template,
      consent: consent('member-synthetic-2'),
      address: 'two@example.test',
      suppressions: [{ address: bounce.suppressedAddress }],
      partitionFields: ['plan_tier'],
    });
    expect(otherAddress.run?.send?.memberId).toBe('member-synthetic-2');
  });
});
