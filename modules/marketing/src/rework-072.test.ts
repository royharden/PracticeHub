import type { CanSendInput, ConsentStateRow } from '@practicehub/consent';
import { describe, expect, it } from 'vitest';

import {
  applyBounceAndSuppress,
  applyComplaint,
  deliverToMember,
  DeliverabilityPosture,
  SuppressionStore,
  type MemberChannelDirectory,
} from './deliverability.js';
import type { Wp070CrmMember } from './placeholder.js';
import { demographicFields, partitionAllows } from './suppression.js';

const tenantA = 'tenant-synthetic-a';
const sender = 'sender-marketing-1';

const member = (memberId: string, tenantId = tenantA): Wp070CrmMember => ({
  placeholderFor: 'WP-070',
  memberId,
  tenantId,
  synthetic: true,
});

function consent(personRef: string, tenantId = tenantA): CanSendInput {
  const state: ConsentStateRow = {
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

const directory: MemberChannelDirectory = {
  addressOf: (tenantId, memberId) =>
    tenantId === tenantA
      ? ({ 'member-a': 'a@example.test', 'member-b': 'b@example.test' } as Record<string, string>)[
          memberId
        ]
      : undefined,
};

const campaign = { campaignId: 'camp-a', segmentId: 'segment-core' };
const template = {
  templateId: 'tmpl-1',
  body: 'Synthetic panel reminder {{unsubscribe_url}} {{postal_address}}',
};
// H-19: a named-segment campaign needs its segment, and a marketing send needs CAN-SPAM context.
const h19Segment = {
  rule: { segmentId: 'segment-core', criteria: { plan_tier: ['core'] } },
  profile: { plan_tier: 'core' },
};
const h19CanSpam = {
  unsubscribeUrl: 'https://example.test/u/synthetic',
  postalAddress: '1 Synthetic Way, Reno NV',
};

function send(memberId: string, store: SuppressionStore, posture: DeliverabilityPosture) {
  return deliverToMember({
    member: member(memberId),
    senderId: sender,
    campaign,
    template,
    consent: consent(memberId),
    directory,
    store,
    posture,
    partitionFields: ['region'],
    segment: h19Segment,
    canSpam: h19CanSpam,
  });
}

describe('WP-072 rework F1: suppression is bound to the member, not a caller address', () => {
  it("sends only to the member's own address and records it on the send", () => {
    const result = send('member-a', new SuppressionStore(), new DeliverabilityPosture());
    expect(result.blocked).toBeNull();
    expect(result.send?.address).toBe('a@example.test');
    expect(result.send?.memberId).toBe('member-a');
  });

  it('a suppressed address cannot be bypassed: there is no caller address to swap', () => {
    const store = new SuppressionStore();
    store.suppressAddress(tenantA, 'A@Example.test ', 'bounce');
    expect(send('member-a', store, new DeliverabilityPosture()).blocked).toBe('suppressed-address');
    expect(send('member-b', store, new DeliverabilityPosture()).blocked).toBeNull();
  });

  it('suppression by person blocks the member whatever address they have', () => {
    const store = new SuppressionStore();
    store.suppressPerson(tenantA, 'member-a', 'unsubscribe');
    expect(send('member-a', store, new DeliverabilityPosture()).blocked).toBe('suppressed-person');
  });

  it('suppression is tenant-scoped and a member with no address is not sent', () => {
    const store = new SuppressionStore();
    store.suppressPerson('tenant-synthetic-b', 'member-a', 'unsubscribe');
    expect(send('member-a', store, new DeliverabilityPosture()).blocked).toBeNull();
    expect(send('member-z', store, new DeliverabilityPosture()).blocked).toBe('no-address');
  });
});

describe('WP-072 rework F2: deliverability posture', () => {
  it('pauses a sender when the bounce rate crosses the threshold and resumes only by attribution', () => {
    const posture = new DeliverabilityPosture({
      bounceRateBps: 200,
      complaintRateBps: 10,
      minSends: 100,
    });
    for (let i = 0; i < 100; i += 1) posture.recordSend(tenantA, sender);
    posture.recordBounce(tenantA, sender);
    posture.recordBounce(tenantA, sender);
    expect(posture.canSend(tenantA, sender)).toBe(true);
    posture.recordBounce(tenantA, sender);
    expect(posture.get(tenantA, sender)).toMatchObject({
      state: 'paused',
      pauseReason: 'bounce-rate',
    });
    expect(send('member-a', new SuppressionStore(), posture).blocked).toBe('sender-paused');
    expect(posture.canSend('tenant-synthetic-b', sender)).toBe(true);
    expect(() => posture.resume(tenantA, sender, '', 'fixed list')).toThrow(/attributed/);
    posture.resume(tenantA, sender, 'staff-deliverability', 'list hygiene done');
    expect(posture.canSend(tenantA, sender)).toBe(true);
  });

  it('pauses on complaint rate, and a complaint suppresses the person', () => {
    const posture = new DeliverabilityPosture({
      bounceRateBps: 10_000,
      complaintRateBps: 10,
      minSends: 100,
    });
    for (let i = 0; i < 1000; i += 1) posture.recordSend(tenantA, sender);
    const store = new SuppressionStore();
    applyComplaint({ tenantId: tenantA, senderId: sender, memberId: 'member-b', store, posture });
    expect(store.isPersonSuppressed(tenantA, 'member-b')).toBe(true);
    expect(posture.canSend(tenantA, sender)).toBe(true);
    applyComplaint({ tenantId: tenantA, senderId: sender, memberId: 'member-a', store, posture });
    expect(posture.get(tenantA, sender).pauseReason).toBe('complaint-rate');
  });

  it('a bounce writes the suppression itself and never retargets the household', () => {
    const store = new SuppressionStore();
    const posture = new DeliverabilityPosture();
    const result = applyBounceAndSuppress({
      tenantId: tenantA,
      senderId: sender,
      bouncedMemberId: 'member-a',
      address: 'a@example.test',
      household: [
        { member: member('member-a'), address: 'a@example.test' },
        { member: member('member-b'), address: 'b@example.test' },
      ],
      store,
      posture,
    });
    expect(result.retargetMemberId).toBeNull();
    expect(store.isAddressSuppressed(tenantA, 'a@example.test')).toBe(true);
    expect(posture.get(tenantA, sender).bounces).toBe(1);
    expect(send('member-a', store, posture).blocked).toBe('suppressed-address');
    expect(send('member-b', store, posture).send?.address).toBe('b@example.test');
  });
});

describe('WP-072 rework F3: seeded partition fuzz', () => {
  it('fails closed exactly when any non-demographic field appears (3000 seeded cases)', () => {
    const pool = [
      ...demographicFields,
      'memberId',
      'email',
      'AGE_BAND',
      'age_band ',
      '',
      'household_id',
      '__proto__',
      'constructor',
      'toString',
    ];
    const allowed = new Set<string>(demographicFields);
    let seed = 20260925;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let accepted = 0;
    for (let i = 0; i < 3000; i += 1) {
      const fields = Array.from(
        { length: Math.floor(next() * 5) },
        () => pool[Math.floor(next() * pool.length)] ?? '',
      );
      const expected = fields.length > 0 && fields.every((field) => allowed.has(field));
      expect(partitionAllows(fields)).toBe(expected);
      if (expected) accepted += 1;
    }
    expect(accepted).toBeGreaterThan(0);
  });
});
