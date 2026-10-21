import type { CanSendInput } from '@practicehub/consent';

import { canSend } from './cansend.js';
import type { Wp070CrmMember } from './placeholder.js';
import {
  memberInSegment,
  renderCanSpamTemplate,
  type CanSpamContext,
  type DemographicProfile,
  type SegmentRule,
} from './segments.js';

export interface Segment {
  readonly segmentId: string;
  readonly name: string;
}

export interface Campaign {
  readonly campaignId: string;
  readonly segmentId: string;
}

export interface Template {
  readonly templateId: string;
  readonly body: string;
}

export interface RecordedSend {
  readonly sendId: string;
  readonly memberId: string;
  readonly campaignId: string;
  readonly templateId: string;
  readonly purpose: 'marketing';
  readonly body: string;
}

export type JourneyRefusal =
  | 'consent-recipient-mismatch'
  | 'consent-denied'
  | 'not-in-segment'
  | 'segment-mismatch'
  | 'segment-required'
  | 'can-spam-missing';

export interface JourneyRun {
  readonly memberId: string;
  readonly steps: readonly ('entered' | 'rendered' | 'refused' | 'sent')[];
  readonly send: RecordedSend | null;
  /** Why the journey refused; absent when it sent. */
  readonly refusal?: JourneyRefusal;
}

/**
 * The consent evaluated must be the recipient's own: same tenant and same
 * person on the request and on the folded consent row.
 */
export function consentBelongsTo(member: Wp070CrmMember, consent: CanSendInput): boolean {
  if (consent.tenantId !== member.tenantId || consent.personRef !== member.memberId) {
    return false;
  }
  return (
    consent.state === null ||
    (consent.state.tenantId === member.tenantId && consent.state.personRef === member.memberId)
  );
}

export function runJourney(input: {
  readonly member: Wp070CrmMember;
  readonly campaign: Campaign;
  readonly template: Template;
  readonly consent: CanSendInput;
  /**
   * The campaign's segment rule and the member's profile. Required whenever the campaign names a
   * segment (NR-156): a campaign cannot skip its own segment by omitting it.
   */
  readonly segment?: { readonly rule: SegmentRule; readonly profile: DemographicProfile };
  /**
   * CAN-SPAM context (NR-157). A marketing send is rendered through renderCanSpamTemplate; without
   * the context, or with a template missing the unsubscribe or postal token, nothing is sent.
   */
  readonly canSpam?: CanSpamContext;
}): JourneyRun {
  if (input.member.placeholderFor !== 'WP-070') {
    throw new Error('journey member must be the WP-070 placeholder');
  }
  const refuse = (steps: JourneyRun['steps'], refusal: JourneyRefusal): JourneyRun => ({
    memberId: input.member.memberId,
    steps: [...steps, 'refused'],
    send: null,
    refusal,
  });
  if (input.segment === undefined) {
    if (input.campaign.segmentId.trim() !== '') {
      return refuse(['entered'], 'segment-required');
    }
  } else {
    if (input.segment.rule.segmentId !== input.campaign.segmentId) {
      return refuse(['entered'], 'segment-mismatch');
    }
    if (!memberInSegment(input.segment.profile, input.segment.rule)) {
      return refuse(['entered'], 'not-in-segment');
    }
  }
  if (!consentBelongsTo(input.member, input.consent)) {
    return refuse(['entered'], 'consent-recipient-mismatch');
  }
  if (input.canSpam === undefined) {
    return refuse(['entered'], 'can-spam-missing');
  }
  let body: string;
  try {
    body = renderCanSpamTemplate(input.template.body, input.canSpam);
  } catch {
    return refuse(['entered'], 'can-spam-missing');
  }
  const steps: ('entered' | 'rendered' | 'refused' | 'sent')[] = ['entered', 'rendered'];
  const decision = canSend(input.consent);
  if (!decision.allow || input.consent.purpose !== 'marketing') {
    return refuse(steps, 'consent-denied');
  }
  steps.push('sent');
  return {
    memberId: input.member.memberId,
    steps,
    send: {
      sendId: `send-${input.member.memberId}-${input.campaign.campaignId}`,
      memberId: input.member.memberId,
      campaignId: input.campaign.campaignId,
      templateId: input.template.templateId,
      purpose: 'marketing',
      body,
    },
  };
}
