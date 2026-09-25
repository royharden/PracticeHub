import type { CanSendInput } from '@practicehub/consent';

import { runJourney } from './journey.js';
import type { Campaign, JourneyRun, Template } from './journey.js';
import type { Wp070CrmMember } from './placeholder.js';

export const demographicFields = ['age_band', 'region', 'plan_tier'] as const;

export function partitionAllows(fields: readonly string[]): boolean {
  return (
    fields.length > 0 &&
    fields.every((field) => (demographicFields as readonly string[]).includes(field))
  );
}

export interface Suppression {
  readonly address: string;
}

export function isSuppressed(address: string, list: readonly Suppression[]): boolean {
  const needle = address.trim().toLowerCase();
  return list.some((row) => row.address.trim().toLowerCase() === needle);
}

export interface HouseholdMember {
  readonly member: Wp070CrmMember;
  readonly address: string;
}

export interface BounceResult {
  readonly bouncedMemberId: string;
  readonly suppressedAddress: string;
  readonly retargetMemberId: null;
}

export function applyBounce(input: {
  readonly bouncedMemberId: string;
  readonly address: string;
  readonly household: readonly HouseholdMember[];
}): BounceResult {
  const bounced = input.household.find((row) => row.member.memberId === input.bouncedMemberId);
  if (
    bounced === undefined ||
    bounced.address.trim().toLowerCase() !== input.address.trim().toLowerCase()
  ) {
    throw new Error('bounce address must belong to the bounced member');
  }
  return {
    bouncedMemberId: input.bouncedMemberId,
    suppressedAddress: bounced.address,
    retargetMemberId: null,
  };
}

export function deliver(input: {
  readonly member: Wp070CrmMember;
  readonly campaign: Campaign;
  readonly template: Template;
  readonly consent: CanSendInput;
  readonly address: string;
  readonly suppressions: readonly Suppression[];
  readonly partitionFields: readonly string[];
}): { readonly blocked: 'partition' | 'suppressed' | null; readonly run: JourneyRun | null } {
  if (!partitionAllows(input.partitionFields)) {
    return { blocked: 'partition', run: null };
  }
  if (isSuppressed(input.address, input.suppressions)) {
    return { blocked: 'suppressed', run: null };
  }
  return {
    blocked: null,
    run: runJourney({
      member: input.member,
      campaign: input.campaign,
      template: input.template,
      consent: input.consent,
    }),
  };
}
