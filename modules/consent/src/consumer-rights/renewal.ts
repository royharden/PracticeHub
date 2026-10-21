/**
 * Auto-renewal to the strictest state (R6-REQ-075, R6-SR-070/071,
 * REQ-MEM-066, REQ-MEM-034). The rules are data: a table keyed by state with
 * a CA-grade baseline, versioned, replaceable without a code change (EX2).
 *
 * - The policy for a member is the strictest merge of the baseline, the state
 *   of record and, while a move is unconfirmed, the prior state (EX1).
 * - The reminder window is the intersection of every applicable window.
 * - A cancel flow is checked against the policy: no mandatory phone or agent
 *   step, no mandatory retention offer, no more steps than sign-up or the
 *   state cap, and an optional exit survey (R6-SR-071, REQ-MEM-034 AC2).
 * - A completed cancellation is confirmed in writing and is never reversed by
 *   a later renewal job; an open balance never blocks it (AC4, EX1).
 */

import { plusDays, ConsumerRightsError, type MembershipView } from './contracts.js';

export interface RenewalRule {
  /** Earliest the pre-renewal notice may go out, in days before renewal. */
  readonly reminderMaxDaysBefore: number;
  /** Latest the pre-renewal notice may go out, in days before renewal. */
  readonly reminderMinDaysBefore: number;
  readonly requiredNoticeContent: readonly string[];
  readonly onlineCancelRequired: boolean;
  readonly maxCancelSteps: number;
  readonly writtenConfirmationRequired: boolean;
}

export interface RenewalRules {
  readonly version: string;
  readonly baseline: RenewalRule;
  readonly states: Readonly<Record<string, RenewalRule>>;
}

/** Counsel-confirmed values; the CA-grade baseline applies wherever no state is stricter. */
export const RENEWAL_RULES_V1: RenewalRules = {
  version: 'auto-renewal/v1',
  baseline: {
    reminderMaxDaysBefore: 45,
    reminderMinDaysBefore: 15,
    requiredNoticeContent: ['price', 'renewal-date', 'cancel-how-to'],
    onlineCancelRequired: true,
    maxCancelSteps: 3,
    writtenConfirmationRequired: true,
  },
  states: {
    IL: {
      reminderMaxDaysBefore: 60,
      reminderMinDaysBefore: 30,
      requiredNoticeContent: ['price', 'renewal-date', 'cancel-how-to', 'term-length'],
      onlineCancelRequired: true,
      maxCancelSteps: 3,
      writtenConfirmationRequired: true,
    },
    MN: {
      reminderMaxDaysBefore: 60,
      reminderMinDaysBefore: 20,
      requiredNoticeContent: ['price', 'renewal-date', 'cancel-how-to'],
      onlineCancelRequired: true,
      maxCancelSteps: 2,
      writtenConfirmationRequired: true,
    },
  },
};

export interface RenewalPolicy {
  readonly rulesVersion: string;
  readonly appliedStates: readonly string[];
  readonly rule: RenewalRule;
}

function isRule(value: unknown): value is RenewalRule {
  if (typeof value !== 'object' || value === null) return false;
  const rule = value as Partial<RenewalRule>;
  return (
    typeof rule.reminderMaxDaysBefore === 'number' &&
    typeof rule.reminderMinDaysBefore === 'number' &&
    rule.reminderMinDaysBefore <= rule.reminderMaxDaysBefore &&
    Array.isArray(rule.requiredNoticeContent) &&
    rule.requiredNoticeContent.every((item) => typeof item === 'string') &&
    typeof rule.onlineCancelRequired === 'boolean' &&
    typeof rule.maxCancelSteps === 'number' &&
    rule.maxCancelSteps >= 1 &&
    typeof rule.writtenConfirmationRequired === 'boolean'
  );
}

/** Load a rules table from configuration (JSON), refusing anything malformed. */
export function parseRenewalRules(raw: unknown): RenewalRules {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConsumerRightsError('RENEWAL_RULES', 'renewal rules must be an object');
  }
  const rules = raw as Partial<RenewalRules>;
  if (typeof rules.version !== 'string' || !isRule(rules.baseline)) {
    throw new ConsumerRightsError(
      'RENEWAL_RULES',
      'renewal rules need a version and a valid baseline',
    );
  }
  const states = rules.states ?? {};
  if (typeof states !== 'object' || !Object.values(states).every(isRule)) {
    throw new ConsumerRightsError('RENEWAL_RULES', 'every state rule must be valid');
  }
  return { version: rules.version, baseline: rules.baseline, states };
}

/**
 * The strictest merge for a member: baseline, state of record, and the prior
 * state while a move is unconfirmed. Windows intersect; content unions; any
 * online-cancel or confirmation requirement holds; the lowest step cap wins.
 */
export function resolveRenewalPolicy(
  member: Pick<MembershipView, 'stateOfRecord' | 'priorStateOfRecord'>,
  rules: RenewalRules = RENEWAL_RULES_V1,
): RenewalPolicy {
  const states = [
    member.stateOfRecord,
    ...(member.priorStateOfRecord === null ? [] : [member.priorStateOfRecord]),
  ];
  const applied = [...new Set(states)].filter((state) => rules.states[state] !== undefined);
  const merged = applied.reduce<RenewalRule>((strictest, state) => {
    const rule = rules.states[state];
    if (rule === undefined) return strictest;
    return {
      reminderMaxDaysBefore: Math.min(strictest.reminderMaxDaysBefore, rule.reminderMaxDaysBefore),
      reminderMinDaysBefore: Math.max(strictest.reminderMinDaysBefore, rule.reminderMinDaysBefore),
      requiredNoticeContent: [
        ...new Set([...strictest.requiredNoticeContent, ...rule.requiredNoticeContent]),
      ],
      onlineCancelRequired: strictest.onlineCancelRequired || rule.onlineCancelRequired,
      maxCancelSteps: Math.min(strictest.maxCancelSteps, rule.maxCancelSteps),
      writtenConfirmationRequired:
        strictest.writtenConfirmationRequired || rule.writtenConfirmationRequired,
    };
  }, rules.baseline);
  if (merged.reminderMinDaysBefore > merged.reminderMaxDaysBefore) {
    throw new ConsumerRightsError(
      'RENEWAL_WINDOW_CONFLICT',
      `no reminder date satisfies ${['baseline', ...applied].join(', ')}`,
    );
  }
  return { rulesVersion: rules.version, appliedStates: applied, rule: merged };
}

export interface RenewalNotice {
  readonly membershipId: string;
  readonly windowOpens: string;
  readonly windowCloses: string;
  readonly due: boolean;
  readonly content: Readonly<Record<string, string>>;
}

/** Whether the pre-renewal notice is due on `at`, and what it must say. */
export function renewalNotice(
  membership: MembershipView,
  policy: RenewalPolicy,
  at: string,
): RenewalNotice {
  const windowOpens = plusDays(membership.renewalDate, -policy.rule.reminderMaxDaysBefore);
  const windowCloses = plusDays(membership.renewalDate, -policy.rule.reminderMinDaysBefore);
  const available: Record<string, string> = {
    price: `${String(membership.priceMinor)} minor units`,
    'renewal-date': membership.renewalDate.slice(0, 10),
    'cancel-how-to': 'cancel online in the member portal in one step',
    'term-length': `${String(membership.termMonths)} months`,
  };
  const content: Record<string, string> = {};
  for (const item of policy.rule.requiredNoticeContent) {
    const text = available[item];
    if (text === undefined) {
      throw new ConsumerRightsError('RENEWAL_CONTENT', `no notice text for required item ${item}`);
    }
    content[item] = text;
  }
  const now = Date.parse(at);
  return {
    membershipId: membership.membershipId,
    windowOpens,
    windowCloses,
    due:
      membership.status === 'active' &&
      now >= Date.parse(windowOpens) &&
      now <= Date.parse(windowCloses),
    content,
  };
}

export type CancelStepKind =
  | 'confirm-cancel'
  | 'exit-survey'
  | 'retention-offer'
  | 'phone-call'
  | 'agent-chat'
  | 'reauthenticate';

export interface CancelStep {
  readonly kind: CancelStepKind;
  /** A required step must be completed before the cancellation takes effect. */
  readonly required: boolean;
}

export interface CancelFlow {
  readonly channel: 'online' | 'phone-only';
  readonly steps: readonly CancelStep[];
  readonly signupSteps: number;
}

/** Every way a cancel flow breaks the policy; an empty list means it complies. */
export function cancelFlowViolations(flow: CancelFlow, policy: RenewalPolicy): readonly string[] {
  const violations: string[] = [];
  if (policy.rule.onlineCancelRequired && flow.channel !== 'online') {
    violations.push('cancellation must be available online');
  }
  for (const step of flow.steps) {
    if (step.required && (step.kind === 'phone-call' || step.kind === 'agent-chat')) {
      violations.push(`mandatory ${step.kind} step`);
    }
    if (step.required && step.kind === 'retention-offer') {
      violations.push('mandatory retention offer');
    }
    if (step.required && step.kind === 'exit-survey') {
      violations.push('exit survey must be optional');
    }
  }
  const requiredSteps = flow.steps.filter((step) => step.required).length;
  const cap = Math.min(policy.rule.maxCancelSteps, flow.signupSteps);
  if (requiredSteps > cap) {
    violations.push(`${String(requiredSteps)} required steps exceed the cap of ${String(cap)}`);
  }
  if (!flow.steps.some((step) => step.kind === 'confirm-cancel' && step.required)) {
    violations.push('no single confirm-cancel step');
  }
  return violations;
}

export interface Cancellation {
  readonly tenantId: string;
  readonly membershipId: string;
  readonly requestedAt: string;
  readonly effectiveEnd: string;
  readonly confirmation: string;
  readonly openBalanceMinor: number;
  readonly vintageRef: string;
  readonly winBackFlag: true;
  readonly exitReason: string | null;
}

/**
 * Cancel in one step. The effective end is the end of the paid period (the
 * renewal date) unless immediate is chosen; entitlements run to that date. An
 * open balance is carried separately and never blocks.
 */
export function cancelMembership(
  membership: MembershipView,
  input: {
    readonly at: string;
    readonly immediate: boolean;
    readonly openBalanceMinor: number;
    readonly exitReason: string | null;
  },
  policy: RenewalPolicy,
): Cancellation {
  if (membership.status === 'cancelled') {
    throw new ConsumerRightsError('RENEWAL_CANCELLED', 'membership is already cancelled');
  }
  const effectiveEnd = input.immediate ? input.at : membership.renewalDate;
  return {
    tenantId: membership.tenantId,
    membershipId: membership.membershipId,
    requestedAt: input.at,
    effectiveEnd,
    confirmation: policy.rule.writtenConfirmationRequired
      ? `written confirmation: membership ${membership.membershipId} ends ${effectiveEnd.slice(0, 10)}; no further renewal charges`
      : 'confirmed',
    openBalanceMinor: input.openBalanceMinor,
    vintageRef: membership.vintageRef,
    winBackFlag: true,
    exitReason: input.exitReason,
  };
}

/** A pre-renewal notice that actually went out. */
export interface RenewalNoticeSent {
  readonly tenantId: string;
  readonly membershipId: string;
  readonly sentAt: string;
}

/**
 * A renewal job renews only an active membership, in its own tenant, with no
 * completed cancellation (AC4), once the renewal date is reached, and only if a
 * pre-renewal notice was sent inside the policy window (R6-REQ-075). Otherwise
 * the renewal is held for review.
 */
export function shouldAutoRenew(
  membership: MembershipView,
  cancellations: readonly Cancellation[],
  at: string,
  noticesSent: readonly RenewalNoticeSent[],
  policy: RenewalPolicy,
): boolean {
  if (membership.status !== 'active') return false;
  const mine = (record: { readonly tenantId: string; readonly membershipId: string }) =>
    record.tenantId === membership.tenantId && record.membershipId === membership.membershipId;
  if (cancellations.some(mine)) return false;
  if (Date.parse(at) < Date.parse(membership.renewalDate)) return false;
  const opens = Date.parse(plusDays(membership.renewalDate, -policy.rule.reminderMaxDaysBefore));
  const closes = Date.parse(plusDays(membership.renewalDate, -policy.rule.reminderMinDaysBefore));
  return noticesSent.some(
    (notice) =>
      mine(notice) && Date.parse(notice.sentAt) >= opens && Date.parse(notice.sentAt) <= closes,
  );
}

/** Entitlements hold through the effective end date, not the request date (REQ-MEM-034 EX2). */
export function entitledOn(cancellation: Cancellation, at: string): boolean {
  return Date.parse(at) < Date.parse(cancellation.effectiveEnd);
}
