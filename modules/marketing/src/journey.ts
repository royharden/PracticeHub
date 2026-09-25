import type { CanSendInput } from '@practicehub/consent';

import { canSend } from './cansend.js';
import type { Wp070CrmMember } from './placeholder.js';

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

export interface JourneyRun {
  readonly memberId: string;
  readonly steps: readonly ('entered' | 'rendered' | 'refused' | 'sent')[];
  readonly send: RecordedSend | null;
}

export function runJourney(input: {
  readonly member: Wp070CrmMember;
  readonly campaign: Campaign;
  readonly template: Template;
  readonly consent: CanSendInput;
}): JourneyRun {
  if (input.member.placeholderFor !== 'WP-070') {
    throw new Error('journey member must be the WP-070 placeholder');
  }
  const steps: ('entered' | 'rendered' | 'refused' | 'sent')[] = ['entered', 'rendered'];
  const decision = canSend(input.consent);
  if (!decision.allow || input.consent.purpose !== 'marketing') {
    steps.push('refused');
    return { memberId: input.member.memberId, steps, send: null };
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
      body: input.template.body,
    },
  };
}
