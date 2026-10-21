import { demographicFields } from './suppression.js';

export type DemographicField = (typeof demographicFields)[number];

/** A member's demographic partition values; the only fields a segment may use. */
export type DemographicProfile = Readonly<Partial<Record<DemographicField, string>>>;

export interface SegmentRule {
  readonly segmentId: string;
  /** Each named field must take one of the listed values (AND across fields). */
  readonly criteria: Readonly<Partial<Record<DemographicField, readonly string[]>>>;
}

/**
 * Segment membership over the demographic partition only. An empty rule or a
 * rule naming a non-demographic field matches nobody (fail closed).
 */
export function memberInSegment(profile: DemographicProfile, rule: SegmentRule): boolean {
  const entries = Object.entries(rule.criteria);
  if (entries.length === 0) {
    return false;
  }
  return entries.every(([field, allowed]) => {
    if (
      !(demographicFields as readonly string[]).includes(field) ||
      allowed === undefined ||
      allowed.length === 0
    ) {
      return false;
    }
    const value = profile[field as DemographicField];
    return value !== undefined && allowed.includes(value);
  });
}

export interface CanSpamContext {
  readonly unsubscribeUrl: string;
  readonly postalAddress: string;
}

const unsubscribeToken = '{{unsubscribe_url}}';
const postalToken = '{{postal_address}}';

/**
 * Renders a marketing template. CAN-SPAM: the body must carry an unsubscribe
 * link and the sender's postal address, so a template without both tokens is
 * refused rather than sent without them.
 */
export function renderCanSpamTemplate(body: string, context: CanSpamContext): string {
  if (!body.includes(unsubscribeToken) || !body.includes(postalToken)) {
    throw new Error('marketing template must include {{unsubscribe_url}} and {{postal_address}}');
  }
  if (!/^https:\/\/\S+$/.test(context.unsubscribeUrl) || context.postalAddress.trim() === '') {
    throw new Error('CAN-SPAM context needs an https unsubscribe URL and a postal address');
  }
  return body
    .split(unsubscribeToken)
    .join(context.unsubscribeUrl)
    .split(postalToken)
    .join(context.postalAddress);
}
