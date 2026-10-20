/**
 * Clinician-initiated termination of a care relationship (REQ-CLIN-001,
 * RT-GAP termination). Proposed -> approved -> noticed -> continuity checklist
 * worked -> closed, with explicit blockers and a reversal path.
 *
 * - Approval needs a physician or APP, a nondiscrimination check, a notice
 *   method, a coverage window at least the jurisdiction minimum, and a policy
 *   basis (AC1). A suspected discriminatory or retaliatory reason blocks (EX1).
 * - Every open clinical item, records-transfer access and any active
 *   membership gets a named owner and a terminal outcome (AC2).
 * - Closure needs a delivered notice, the coverage window elapsed, every item
 *   terminal and the urgent-risk disposition recorded (AC3); a critical item,
 *   failed notice or unresolved urgent need blocks and escalates (EX1).
 * - A reversal restores the relationship and lists every event from the
 *   inactive interval for reconciliation (EX2).
 */

import {
  plusDays,
  ConsumerRightsError,
  type EncountersReadPort,
  type MembershipReadPort,
  type OpenClinicalKind,
} from './contracts.js';

export interface TerminationRuleset {
  readonly version: string;
  /** Minimum coverage window, per jurisdiction, in days (counsel-confirmed). */
  readonly minimumCoverageDays: Readonly<Record<string, number>>;
  readonly defaultCoverageDays: number;
}

export const TERMINATION_RULESET_V1: TerminationRuleset = {
  version: 'clinical-termination/v1',
  minimumCoverageDays: { NV: 30, FL: 30, IL: 30, MN: 30 },
  defaultCoverageDays: 30,
};

export type TerminationState =
  'proposed' | 'approved' | 'noticed' | 'closed' | 'reversed' | 'escalated' | 'rejected';

export type ChecklistKind = OpenClinicalKind | 'records-transfer-access' | 'membership-billing';

export type TerminalOutcome =
  'completed' | 'transferred-accepted' | 'cancelled-with-notice' | 'declined-by-patient';

export interface ChecklistItem {
  readonly itemId: string;
  readonly kind: ChecklistKind;
  readonly description: string;
  readonly critical: boolean;
  readonly ownerId: string | null;
  readonly outcome: TerminalOutcome | null;
  readonly evidenceRef: string | null;
}

export interface TerminationEvent {
  readonly at: string;
  readonly kind: string;
  readonly detail: string;
}

export interface TerminationCase {
  readonly terminationId: string;
  readonly tenantId: string;
  readonly patientRef: string;
  readonly clinicianId: string;
  readonly jurisdiction: string;
  readonly reason: string;
  readonly noticeMethod: 'mail' | 'portal' | 'mail-and-portal';
  readonly coverageDays: number;
  readonly rulesetVersion: string;
  readonly state: TerminationState;
  readonly approval: { readonly approverId: string; readonly at: string } | null;
  readonly effectiveAt: string | null;
  readonly notice: { readonly at: string; readonly delivered: boolean } | null;
  readonly urgentRiskDisposition: string | null;
  readonly checklist: readonly ChecklistItem[];
  readonly blockers: readonly string[];
  readonly events: readonly TerminationEvent[];
}

function refuse(code: string, message: string): never {
  throw new ConsumerRightsError(code, message);
}

function log(
  termination: TerminationCase,
  at: string,
  kind: string,
  detail: string,
): TerminationCase {
  return { ...termination, events: [...termination.events, { at, kind, detail }] };
}

export function proposeTermination(
  input: {
    readonly terminationId: string;
    readonly tenantId: string;
    readonly patientRef: string;
    readonly clinicianId: string;
    readonly jurisdiction: string;
    readonly reason: string;
    readonly noticeMethod: TerminationCase['noticeMethod'];
    readonly coverageDays: number;
    readonly at: string;
  },
  ruleset: TerminationRuleset = TERMINATION_RULESET_V1,
): TerminationCase {
  if (input.reason.trim() === '')
    refuse('TERMINATION_REASON', 'a termination needs a stated reason');
  const minimum = ruleset.minimumCoverageDays[input.jurisdiction] ?? ruleset.defaultCoverageDays;
  if (input.coverageDays < minimum) {
    refuse(
      'TERMINATION_COVERAGE',
      `coverage window ${String(input.coverageDays)} days is below the ${input.jurisdiction} minimum of ${String(minimum)}`,
    );
  }
  return {
    terminationId: input.terminationId,
    tenantId: input.tenantId,
    patientRef: input.patientRef,
    clinicianId: input.clinicianId,
    jurisdiction: input.jurisdiction,
    reason: input.reason,
    noticeMethod: input.noticeMethod,
    coverageDays: input.coverageDays,
    rulesetVersion: ruleset.version,
    state: 'proposed',
    approval: null,
    effectiveAt: null,
    notice: null,
    urgentRiskDisposition: null,
    checklist: [],
    blockers: [],
    events: [{ at: input.at, kind: 'proposed', detail: input.reason }],
  };
}

/**
 * Approve the termination. Only a physician or APP may approve, and a
 * suspected discriminatory or retaliatory reason escalates instead.
 */
export function approveTermination(
  termination: TerminationCase,
  input: {
    readonly approverId: string;
    readonly approverRole: 'physician' | 'app' | 'staff';
    readonly nondiscriminationChecked: boolean;
    readonly suspectedDiscriminationOrRetaliation: boolean;
    readonly at: string;
  },
): TerminationCase {
  if (termination.state !== 'proposed')
    refuse('TERMINATION_STATE', `cannot approve from ${termination.state}`);
  if (input.approverRole === 'staff') {
    refuse('TERMINATION_APPROVER', 'an accountable physician or APP must approve');
  }
  if (!input.nondiscriminationChecked) {
    refuse('TERMINATION_NONDISCRIMINATION', 'the nondiscrimination check is required');
  }
  if (input.suspectedDiscriminationOrRetaliation) {
    return log(
      {
        ...termination,
        state: 'escalated',
        blockers: [...termination.blockers, DISCRIMINATION_BLOCKER],
      },
      input.at,
      'escalated',
      'clinical/compliance review',
    );
  }
  return log(
    {
      ...termination,
      state: 'approved',
      approval: { approverId: input.approverId, at: input.at },
      effectiveAt: plusDays(input.at, termination.coverageDays),
    },
    input.at,
    'approved',
    input.approverId,
  );
}

/**
 * Build or refresh the continuity checklist from encounters, records access and
 * membership (AC2). A refresh merges: items already on the list keep their owner,
 * outcome and evidence, and work opened since the last build is added.
 */
export function buildContinuityChecklist(
  termination: TerminationCase,
  encounters: EncountersReadPort,
  membership: MembershipReadPort,
): TerminationCase {
  if (
    termination.state !== 'approved' &&
    termination.state !== 'noticed' &&
    termination.state !== 'escalated'
  ) {
    refuse('TERMINATION_STATE', `cannot build a checklist from ${termination.state}`);
  }
  const clinical: ChecklistItem[] = encounters
    .openItems(termination.tenantId, termination.patientRef)
    .map((item) => ({
      itemId: item.itemRef,
      kind: item.kind,
      description: item.description,
      critical: item.critical,
      ownerId: null,
      outcome: null,
      evidenceRef: null,
    }));
  const records: ChecklistItem = {
    itemId: `${termination.terminationId}:records-transfer`,
    kind: 'records-transfer-access',
    description: 'records-transfer access for the patient and any receiving provider',
    critical: false,
    ownerId: null,
    outcome: null,
    evidenceRef: null,
  };
  const member = membership.membershipFor(termination.tenantId, termination.patientRef);
  const billing: ChecklistItem[] =
    member !== null && member.status !== 'cancelled'
      ? [
          {
            itemId: `${termination.terminationId}:membership:${member.membershipId}`,
            kind: 'membership-billing',
            description: 'end membership billing and entitlements on the effective date',
            critical: false,
            ownerId: null,
            outcome: null,
            evidenceRef: null,
          },
        ]
      : [];
  const fresh = [...clinical, records, ...billing];
  const kept = new Map(termination.checklist.map((item) => [item.itemId, item]));
  // An item keeps its owner, outcome and evidence, but criticality only ever rises: an item
  // that became critical since the last build must block closure as critical (and escalate).
  const merged = fresh.map((item) => {
    const prior = kept.get(item.itemId);
    return prior === undefined ? item : { ...prior, critical: prior.critical || item.critical };
  });
  const carried = termination.checklist.filter(
    (item) => !fresh.some((candidate) => candidate.itemId === item.itemId),
  );
  return { ...termination, checklist: [...merged, ...carried] };
}

function updateItem(
  termination: TerminationCase,
  itemId: string,
  change: (item: ChecklistItem) => ChecklistItem,
): TerminationCase {
  if (!termination.checklist.some((item) => item.itemId === itemId)) {
    refuse('TERMINATION_ITEM', `no checklist item ${itemId}`);
  }
  return {
    ...termination,
    checklist: termination.checklist.map((item) => (item.itemId === itemId ? change(item) : item)),
  };
}

export function assignChecklistItem(
  termination: TerminationCase,
  itemId: string,
  ownerId: string,
): TerminationCase {
  return updateItem(termination, itemId, (item) => ({ ...item, ownerId }));
}

export function resolveChecklistItem(
  termination: TerminationCase,
  itemId: string,
  outcome: TerminalOutcome,
  evidenceRef: string,
): TerminationCase {
  return updateItem(termination, itemId, (item) => {
    if (item.ownerId === null) refuse('TERMINATION_OWNER', `item ${itemId} has no named owner`);
    if (evidenceRef.trim() === '')
      refuse('TERMINATION_EVIDENCE', 'a terminal outcome needs evidence');
    return { ...item, outcome, evidenceRef };
  });
}

export function recordNotice(
  termination: TerminationCase,
  delivered: boolean,
  at: string,
): TerminationCase {
  if (termination.state !== 'approved')
    refuse('TERMINATION_STATE', `cannot notice from ${termination.state}`);
  const noticed: TerminationCase = { ...termination, state: 'noticed', notice: { at, delivered } };
  return log(
    noticed,
    at,
    delivered ? 'notice-delivered' : 'notice-failed',
    termination.noticeMethod,
  );
}

export function recordUrgentRiskDisposition(
  termination: TerminationCase,
  disposition: string,
  at: string,
): TerminationCase {
  if (disposition.trim() === '') refuse('TERMINATION_URGENT', 'the disposition must be stated');
  return log(
    { ...termination, urgentRiskDisposition: disposition },
    at,
    'urgent-risk',
    disposition,
  );
}

/** Every reason the case cannot close yet; an empty list means it can. */
export function terminationBlockers(termination: TerminationCase, at: string): readonly string[] {
  const reasons: string[] = [];
  if (termination.notice === null) reasons.push('notice not issued');
  else if (!termination.notice.delivered) reasons.push('notice delivery failed');
  if (termination.effectiveAt === null || Date.parse(at) < Date.parse(termination.effectiveAt)) {
    reasons.push('coverage window has not elapsed');
  }
  if (termination.urgentRiskDisposition === null)
    reasons.push('urgent-risk disposition not recorded');
  if (!termination.checklist.some((item) => item.kind === 'records-transfer-access')) {
    reasons.push('continuity checklist not built');
  }
  for (const item of termination.checklist) {
    if (item.ownerId === null) reasons.push(`${item.itemId}: no named owner`);
    if (item.outcome === null) {
      reasons.push(
        `${item.itemId}: ${item.critical ? 'critical item unresolved' : 'no terminal outcome'}`,
      );
    }
  }
  return reasons;
}

/**
 * Close (inactivate) the relationship. Any blocker refuses closure; a critical
 * item or failed notice also escalates the case to clinical/compliance review.
 */
export function closeTermination(
  current: TerminationCase,
  at: string,
  ports: { readonly encounters: EncountersReadPort; readonly membership: MembershipReadPort },
): TerminationCase {
  if (current.state !== 'noticed')
    refuse('TERMINATION_STATE', `cannot close from ${current.state}`);
  // Re-read open work at closure: anything opened during the coverage window joins the list.
  const termination = buildContinuityChecklist(current, ports.encounters, ports.membership);
  const reasons = terminationBlockers(termination, at);
  if (reasons.length > 0) {
    const severe = reasons.filter(
      (reason) => reason.includes('critical') || reason === 'notice delivery failed',
    );
    if (severe.length > 0) {
      return log(
        { ...termination, state: 'escalated', blockers: severe },
        at,
        'escalated',
        severe.join('; '),
      );
    }
    refuse('TERMINATION_BLOCKED', reasons.join('; '));
  }
  return log(
    { ...termination, state: 'closed', blockers: [] },
    at,
    'closed',
    'relationship inactivated',
  );
}

/** The blocker a suspected discriminatory or retaliatory reason records on escalation. */
export const DISCRIMINATION_BLOCKER = 'suspected discriminatory or retaliatory reason';

/**
 * Attributed clinical/compliance review of an escalated case (REQ-CLIN-001 EX1).
 * The reviewer is independent: never the proposing clinician or the approver.
 * A suspected-discrimination escalation is reviewed only by a clinical lead or
 * compliance. `return` sends it back into the workflow once the reviewer has
 * addressed the cause: to `proposed` if it was never approved, to `approved` (a
 * new notice is required) if the notice failed, otherwise to `noticed` so closure
 * can be tried again. `reject` ends the termination with the reason recorded.
 */
export function reviewEscalation(
  termination: TerminationCase,
  input: {
    readonly reviewerId: string;
    readonly reviewerRole: 'physician' | 'app' | 'clinical-lead' | 'compliance';
    readonly decision: 'return' | 'reject';
    readonly reason: string;
    readonly at: string;
  },
): TerminationCase {
  if (termination.state !== 'escalated') {
    refuse('TERMINATION_STATE', `only an escalated case is reviewed, not ${termination.state}`);
  }
  if (input.reviewerId.trim() === '' || input.reason.trim() === '') {
    refuse('TERMINATION_REVIEW', 'an escalation review needs a reviewer and a reason');
  }
  const authors = [termination.clinicianId, termination.approval?.approverId].filter(
    (id): id is string => id !== undefined,
  );
  if (authors.includes(input.reviewerId.trim())) {
    refuse(
      'TERMINATION_REVIEWER',
      'an escalation is reviewed by someone independent of the proposing clinician and the approver',
    );
  }
  if (
    termination.blockers.includes(DISCRIMINATION_BLOCKER) &&
    input.reviewerRole !== 'clinical-lead' &&
    input.reviewerRole !== 'compliance'
  ) {
    refuse(
      'TERMINATION_REVIEWER',
      'a suspected-discrimination escalation is reviewed by a clinical lead or compliance',
    );
  }
  const detail = `${input.reviewerRole} ${input.reviewerId}: ${input.reason}`;
  if (input.decision === 'reject') {
    return log({ ...termination, state: 'rejected' }, input.at, 'escalation-rejected', detail);
  }
  const noticeGood = termination.notice !== null && termination.notice.delivered;
  const state: TerminationState =
    termination.approval === null ? 'proposed' : noticeGood ? 'noticed' : 'approved';
  return log(
    {
      ...termination,
      state,
      blockers: [],
      notice: noticeGood ? termination.notice : null,
    },
    input.at,
    'escalation-returned',
    detail,
  );
}

/**
 * Reverse a mistaken termination (EX2): the relationship is restored and every
 * event recorded after approval is returned for reconciliation.
 */
export function reverseTermination(
  termination: TerminationCase,
  by: string,
  at: string,
): { readonly termination: TerminationCase; readonly toReconcile: readonly TerminationEvent[] } {
  if (termination.approval === null) refuse('TERMINATION_STATE', 'nothing was approved to reverse');
  const since = Date.parse(termination.approval.at);
  const toReconcile = termination.events.filter((event) => Date.parse(event.at) >= since);
  return {
    termination: log({ ...termination, state: 'reversed' }, at, 'reversed', by),
    toReconcile,
  };
}
