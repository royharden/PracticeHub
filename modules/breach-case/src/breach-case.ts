import { createHash } from 'node:crypto';

export const breachSourceKinds = [
  'manual',
  'wrong-disclosure',
  'account-takeover',
  'audit-anomaly',
  'vendor-incident',
  'genetic-break-glass',
] as const;
export type BreachSourceKind = (typeof breachSourceKinds)[number];

export const breachCaseStatuses = [
  'assessing',
  'determined-reportable',
  'determined-low-probability',
  'notifying',
  'closed',
] as const;
export type BreachCaseStatus = (typeof breachCaseStatuses)[number];

export type BreachDeterminationKind = 'reportable' | 'low-probability';
export type AcquisitionState = 'not-acquired' | 'viewed' | 'acquired' | 'unknown';
export type MitigationState = 'complete' | 'partial' | 'none' | 'unknown';
export type PhiExtent = 'limited' | 'broad' | 'unknown';
export type RecipientClass = 'workforce' | 'patient' | 'vendor' | 'public' | 'unknown';

export interface NatureFactor {
  readonly phiCategoryRefs: readonly string[];
  readonly extent: PhiExtent;
  readonly evidenceRefs: readonly string[];
}

export interface RecipientFactor {
  readonly recipientClass: RecipientClass;
  readonly relationshipRef: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface AcquisitionFactor {
  readonly state: AcquisitionState;
  readonly evidenceRefs: readonly string[];
}

export interface MitigationFactor {
  readonly state: MitigationState;
  readonly actionRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface FourFactorAssessment {
  readonly assessmentId: string;
  readonly version: number;
  readonly scopeVersion: number;
  readonly assessedAt: string;
  readonly assessedBy: string;
  readonly nature: NatureFactor;
  readonly recipient: RecipientFactor;
  readonly acquisition: AcquisitionFactor;
  readonly mitigation: MitigationFactor;
  readonly complete: boolean;
  readonly synthetic: true;
}

export interface AffectedScopeVersion {
  readonly version: number;
  readonly subjectRefs: readonly string[];
  readonly queryEvidenceRef: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly complete: boolean;
  readonly limitationRef: string | null;
  readonly contentHash: string;
  readonly recordedAt: string;
  readonly synthetic: true;
}

export type DutyStatus = 'open' | 'escalated' | 'satisfied' | 'cancelled';
export type NoticeAudience = 'individual' | 'hhs' | 'media' | 'state-authority';

export interface JurisdictionDuty {
  readonly dutyId: string;
  readonly clockId: string;
  readonly jurisdiction: string;
  readonly contributionFact: 'provider' | 'patient' | 'floor';
  readonly policyVersion: number;
  readonly policyEffectiveOn: string;
  readonly policyRef: string;
  readonly dueAt: string;
  readonly escalationAt: string;
  readonly requiredAudiences: readonly NoticeAudience[];
  readonly status: DutyStatus;
  readonly completionEvidenceRef: string | null;
  readonly synthetic: true;
}

export type NoticeTransportState =
  'prepared' | 'approved' | 'effect-intended' | 'accepted' | 'unknown' | 'delivered' | 'failed';

export interface NotificationEvidence {
  readonly noticeId: string;
  readonly dutyId: string;
  readonly audience: NoticeAudience;
  readonly payloadRef: string;
  readonly preparedBy: string;
  readonly preparedAt: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly effectIntentKey: string | null;
  readonly effectKey: string | null;
  readonly state: NoticeTransportState;
  readonly terminalEvidenceRef: string | null;
  readonly synthetic: true;
}

export interface GeneticTargetedReview {
  readonly reviewId: string;
  readonly grantRef: string;
  readonly auditRef: string;
  readonly workItemRef: string;
  readonly accessorRef: string;
  readonly initiatorRef: string;
  readonly subjectRef: string;
  readonly reviewDueAt: string;
  readonly sourceOccurredAt: string;
  readonly risk: 'critical';
  readonly reviewerRef: string | null;
  readonly disposition: 'appropriate' | 'insufficient-justification' | null;
  readonly evidenceRef: string | null;
  readonly completedAt: string | null;
  readonly synthetic: true;
}

export interface BreachDetermination {
  readonly kind: BreachDeterminationKind;
  readonly assessmentVersion: number;
  readonly rationaleRef: string;
  readonly determinedBy: string;
  readonly approvedBy: string;
  readonly determinedAt: string;
  readonly synthetic: true;
}

export const breachEventTypes = [
  'case-opened',
  'scope-versioned',
  'assessment-recorded',
  'determination-recorded',
  'duty-linked',
  'duty-updated',
  'notice-recorded',
  'evidence-linked',
  'targeted-review-opened',
  'targeted-review-completed',
  'case-reopened',
  'case-closed',
] as const;
export type BreachEventType = (typeof breachEventTypes)[number];

export interface BreachCaseEvent {
  readonly tenantId: string;
  readonly caseId: string;
  readonly eventSeq: number;
  readonly eventKey: string;
  readonly eventType: BreachEventType;
  readonly occurredAt: string;
  readonly actorRef: string;
  readonly sourceKind?: BreachSourceKind;
  readonly sourceRef?: string;
  readonly incidentAt?: string;
  readonly discoveryAt?: string;
  readonly ownerRef?: string;
  readonly assessment?: FourFactorAssessment;
  readonly scope?: AffectedScopeVersion;
  readonly determination?: BreachDetermination;
  readonly duty?: JurisdictionDuty;
  readonly notice?: NotificationEvidence;
  readonly geneticReview?: GeneticTargetedReview;
  readonly evidenceRef?: string;
  readonly retentionEvidenceRef?: string;
  readonly reasonRef?: string;
  readonly synthetic: true;
}

export interface BreachCaseAggregate {
  readonly tenantId: string;
  readonly caseId: string;
  readonly sourceKind: BreachSourceKind;
  readonly sourceRef: string;
  readonly incidentAt: string;
  readonly discoveryAt: string;
  readonly ownerRef: string;
  readonly status: BreachCaseStatus;
  readonly assessments: readonly FourFactorAssessment[];
  readonly affectedScopes: readonly AffectedScopeVersion[];
  readonly duties: readonly JurisdictionDuty[];
  readonly notices: readonly NotificationEvidence[];
  readonly geneticReviews: readonly GeneticTargetedReview[];
  readonly evidenceRefs: readonly string[];
  readonly retentionEvidenceRef: string | null;
  readonly determination: BreachDetermination | null;
  readonly strictestOpenDueAt: string | null;
  readonly lastEventSeq: number;
  readonly events: readonly BreachCaseEvent[];
  readonly synthetic: true;
}

export class BreachCaseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BreachCaseError';
  }
}

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const statePattern = /^(floor|[A-Z]{2})$/;
const phiExtents: readonly PhiExtent[] = ['limited', 'broad', 'unknown'];
const recipientClasses: readonly RecipientClass[] = [
  'workforce',
  'patient',
  'vendor',
  'public',
  'unknown',
];
const acquisitionStates: readonly AcquisitionState[] = [
  'not-acquired',
  'viewed',
  'acquired',
  'unknown',
];
const mitigationStates: readonly MitigationState[] = ['complete', 'partial', 'none', 'unknown'];
const noticeAudiences: readonly NoticeAudience[] = [
  'individual',
  'hhs',
  'media',
  'state-authority',
];

function assertId(value: string, label: string): void {
  if (!idPattern.test(value)) throw new BreachCaseError(`${label} must use id grammar`);
}

function assertRef(value: string, label: string): void {
  if (!refPattern.test(value)) throw new BreachCaseError(`${label} must use ref grammar`);
}

function assertInstant(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) throw new BreachCaseError(`${label} must be an ISO instant`);
}

function uniqueSorted(values: readonly string[], label: string): readonly string[] {
  for (const value of values) assertRef(value, label);
  return [...new Set(values)].sort();
}

function nextEvent(
  aggregate: BreachCaseAggregate,
  event: Omit<BreachCaseEvent, 'tenantId' | 'caseId' | 'eventSeq' | 'synthetic'>,
): BreachCaseEvent {
  return {
    ...event,
    tenantId: aggregate.tenantId,
    caseId: aggregate.caseId,
    eventSeq: aggregate.lastEventSeq + 1,
    synthetic: true,
  };
}

function hashScope(input: {
  readonly subjectRefs: readonly string[];
  readonly queryEvidenceRef: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly complete: boolean;
  readonly limitationRef: string | null;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function validateAssessment(
  assessment: FourFactorAssessment,
  expectedVersion: number,
  expectedScopeVersion: number,
): void {
  assertId(assessment.assessmentId, 'assessmentId');
  assertRef(assessment.assessedBy, 'assessedBy');
  assertInstant(assessment.assessedAt, 'assessedAt');
  if (assessment.synthetic !== true) throw new BreachCaseError('assessment must be synthetic');
  if (assessment.version !== expectedVersion || assessment.scopeVersion !== expectedScopeVersion) {
    throw new BreachCaseError('assessment version/scope correlation mismatch');
  }
  if (!phiExtents.includes(assessment.nature.extent))
    throw new BreachCaseError('invalid nature extent');
  if (!recipientClasses.includes(assessment.recipient.recipientClass)) {
    throw new BreachCaseError('invalid recipient class');
  }
  if (!acquisitionStates.includes(assessment.acquisition.state)) {
    throw new BreachCaseError('invalid acquisition state');
  }
  if (!mitigationStates.includes(assessment.mitigation.state)) {
    throw new BreachCaseError('invalid mitigation state');
  }
  for (const [values, label] of [
    [assessment.nature.phiCategoryRefs, 'phiCategoryRef'],
    [assessment.nature.evidenceRefs, 'natureEvidenceRef'],
    [assessment.recipient.evidenceRefs, 'recipientEvidenceRef'],
    [assessment.acquisition.evidenceRefs, 'acquisitionEvidenceRef'],
    [assessment.mitigation.actionRefs, 'mitigationActionRef'],
    [assessment.mitigation.evidenceRefs, 'mitigationEvidenceRef'],
  ] as const) {
    if (JSON.stringify(values) !== JSON.stringify(uniqueSorted(values, label))) {
      throw new BreachCaseError(`${label} values must be unique and sorted`);
    }
  }
  if (assessment.recipient.relationshipRef !== null) {
    assertRef(assessment.recipient.relationshipRef, 'relationshipRef');
  }
  const evidenceComplete =
    assessment.nature.phiCategoryRefs.length > 0 &&
    assessment.nature.evidenceRefs.length > 0 &&
    assessment.recipient.evidenceRefs.length > 0 &&
    assessment.acquisition.evidenceRefs.length > 0 &&
    assessment.mitigation.evidenceRefs.length > 0;
  if (assessment.complete !== evidenceComplete) {
    throw new BreachCaseError('assessment completeness does not match evidence shape');
  }
}

function validateDuty(duty: JurisdictionDuty): void {
  assertId(duty.dutyId, 'dutyId');
  assertRef(duty.clockId, 'clockId');
  assertRef(duty.policyRef, 'policyRef');
  if (!statePattern.test(duty.jurisdiction)) throw new BreachCaseError('invalid duty jurisdiction');
  if (!['provider', 'patient', 'floor'].includes(duty.contributionFact)) {
    throw new BreachCaseError('invalid duty contribution fact');
  }
  if (!Number.isSafeInteger(duty.policyVersion) || duty.policyVersion < 1) {
    throw new BreachCaseError('invalid duty policy version');
  }
  assertInstant(duty.dueAt, 'dueAt');
  assertInstant(duty.escalationAt, 'escalationAt');
  if (Date.parse(duty.escalationAt) > Date.parse(duty.dueAt)) {
    throw new BreachCaseError('duty escalation cannot follow dueAt');
  }
  if (
    duty.requiredAudiences.length === 0 ||
    new Set(duty.requiredAudiences).size !== duty.requiredAudiences.length ||
    duty.requiredAudiences.some((audience) => !noticeAudiences.includes(audience))
  ) {
    throw new BreachCaseError('duty requires a unique closed set of audiences');
  }
  if (
    (duty.status === 'open' || duty.status === 'escalated') !==
    (duty.completionEvidenceRef === null)
  ) {
    throw new BreachCaseError('duty completion evidence does not match status');
  }
  if (duty.synthetic !== true) throw new BreachCaseError('duty must be synthetic');
}

function validateNotice(
  notice: NotificationEvidence,
  prior: NotificationEvidence | undefined,
): void {
  assertId(notice.noticeId, 'noticeId');
  assertId(notice.dutyId, 'notice dutyId');
  assertRef(notice.payloadRef, 'payloadRef');
  assertRef(notice.preparedBy, 'preparedBy');
  assertInstant(notice.preparedAt, 'preparedAt');
  if (!noticeAudiences.includes(notice.audience))
    throw new BreachCaseError('invalid notice audience');
  if (notice.synthetic !== true) throw new BreachCaseError('notice must be synthetic');
  if (notice.state === 'prepared') {
    if (
      notice.approvedBy !== null ||
      notice.approvedAt !== null ||
      notice.effectIntentKey !== null ||
      notice.effectKey !== null ||
      notice.terminalEvidenceRef !== null
    ) {
      throw new BreachCaseError(
        'prepared notice cannot contain approval, effect, or terminal evidence',
      );
    }
  } else {
    if (notice.approvedBy === null || notice.approvedAt === null) {
      throw new BreachCaseError('notice transport cannot precede human approval');
    }
    assertRef(notice.approvedBy, 'approvedBy');
    assertInstant(notice.approvedAt, 'approvedAt');
    if (notice.approvedBy === notice.preparedBy) {
      throw new BreachCaseError('notice approval must be independent');
    }
    if (Date.parse(notice.approvedAt) < Date.parse(notice.preparedAt)) {
      throw new BreachCaseError('notice approval cannot precede preparation');
    }
  }
  const hasIntent = notice.effectIntentKey !== null;
  const hasEffect = notice.effectKey !== null;
  if (notice.state === 'approved' && (hasIntent || hasEffect)) {
    throw new BreachCaseError('approved notice cannot claim an effect intent/result');
  }
  if (notice.state === 'effect-intended') {
    if (!hasIntent || hasEffect)
      throw new BreachCaseError('effect-intended notice requires only intent');
  }
  if (['accepted', 'unknown', 'delivered', 'failed'].includes(notice.state)) {
    if (!hasIntent || !hasEffect)
      throw new BreachCaseError('notice result requires intent and effect key');
  }
  if (notice.effectIntentKey !== null) assertRef(notice.effectIntentKey, 'effectIntentKey');
  if (notice.effectKey !== null) assertRef(notice.effectKey, 'effectKey');
  if (notice.state === 'delivered' && notice.terminalEvidenceRef === null) {
    throw new BreachCaseError('delivered notice requires terminal evidence');
  }
  if (notice.state !== 'delivered' && notice.terminalEvidenceRef !== null) {
    throw new BreachCaseError('non-terminal transport cannot claim terminal evidence');
  }
  if (prior === undefined) {
    if (notice.state !== 'prepared')
      throw new BreachCaseError('notice lifecycle must begin prepared');
    return;
  }
  if (
    prior.dutyId !== notice.dutyId ||
    prior.audience !== notice.audience ||
    prior.payloadRef !== notice.payloadRef ||
    prior.preparedBy !== notice.preparedBy ||
    prior.preparedAt !== notice.preparedAt ||
    (prior.approvedBy !== null && prior.approvedBy !== notice.approvedBy) ||
    (prior.approvedAt !== null && prior.approvedAt !== notice.approvedAt) ||
    (prior.effectIntentKey !== null && prior.effectIntentKey !== notice.effectIntentKey) ||
    (prior.effectKey !== null && prior.effectKey !== notice.effectKey)
  ) {
    throw new BreachCaseError('notice id was reused with changed immutable intent');
  }
  const allowed = new Set([
    'prepared:approved',
    'approved:effect-intended',
    'effect-intended:accepted',
    'effect-intended:unknown',
    'effect-intended:delivered',
    'effect-intended:failed',
    'accepted:delivered',
    'accepted:failed',
    'unknown:delivered',
    'unknown:failed',
  ]);
  if (!allowed.has(`${prior.state}:${notice.state}`)) {
    if (JSON.stringify(prior) === JSON.stringify(notice)) return;
    throw new BreachCaseError(`invalid notice transition ${prior.state} -> ${notice.state}`);
  }
}

export function assessmentIsKnown(assessment: FourFactorAssessment): boolean {
  return (
    assessment.complete &&
    assessment.nature.extent !== 'unknown' &&
    assessment.recipient.recipientClass !== 'unknown' &&
    assessment.acquisition.state !== 'unknown' &&
    assessment.mitigation.state !== 'unknown'
  );
}

export function strictestOpenDue(duties: readonly JurisdictionDuty[]): string | null {
  const open = duties.filter((duty) => duty.status === 'open' || duty.status === 'escalated');
  const first = open[0];
  if (first === undefined) return null;
  return open.reduce(
    (earliest, duty) => (Date.parse(duty.dueAt) < Date.parse(earliest) ? duty.dueAt : earliest),
    first.dueAt,
  );
}

function replaceById<T>(
  items: readonly T[],
  id: string,
  getId: (item: T) => string,
  value: T,
): readonly T[] {
  const index = items.findIndex((item) => getId(item) === id);
  if (index < 0) return [...items, value];
  return items.map((item, itemIndex) => (itemIndex === index ? value : item));
}

export function foldBreachCase(events: readonly BreachCaseEvent[]): BreachCaseAggregate {
  const first = events[0];
  if (first === undefined || first.eventType !== 'case-opened') {
    throw new BreachCaseError('breach event log must begin with case-opened');
  }
  if (
    first.sourceKind === undefined ||
    first.sourceRef === undefined ||
    first.incidentAt === undefined ||
    first.discoveryAt === undefined ||
    first.ownerRef === undefined
  ) {
    throw new BreachCaseError('case-opened is missing required fields');
  }
  let status: BreachCaseStatus = 'assessing';
  let assessments: readonly FourFactorAssessment[] = [];
  let affectedScopes: readonly AffectedScopeVersion[] = [];
  let duties: readonly JurisdictionDuty[] = [];
  let notices: readonly NotificationEvidence[] = [];
  let geneticReviews: readonly GeneticTargetedReview[] = [];
  let evidenceRefs: readonly string[] = [];
  let retentionEvidenceRef: string | null = null;
  let determination: BreachDetermination | null = null;
  const keys = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.synthetic !== true) throw new BreachCaseError('breach event must be synthetic');
    assertId(event.tenantId, 'event tenantId');
    assertId(event.caseId, 'event caseId');
    assertId(event.eventKey, 'eventKey');
    assertRef(event.actorRef, 'event actorRef');
    assertInstant(event.occurredAt, 'event occurredAt');
    if (!breachEventTypes.includes(event.eventType))
      throw new BreachCaseError('unknown breach event type');
    if (event.tenantId !== first.tenantId || event.caseId !== first.caseId) {
      throw new BreachCaseError('breach event tenant/case correlation mismatch');
    }
    if (event.eventSeq !== index + 1)
      throw new BreachCaseError('breach event sequence is not contiguous');
    if (keys.has(event.eventKey)) throw new BreachCaseError('duplicate breach event key');
    keys.add(event.eventKey);
    if (status === 'closed')
      throw new BreachCaseError('closed breach case cannot accept later events');
    switch (event.eventType) {
      case 'case-opened':
        if (index !== 0) throw new BreachCaseError('case-opened may occur only once');
        if (
          event.sourceKind === undefined ||
          !breachSourceKinds.includes(event.sourceKind) ||
          event.sourceRef === undefined ||
          event.incidentAt === undefined ||
          event.discoveryAt === undefined ||
          event.ownerRef === undefined
        ) {
          throw new BreachCaseError('case-opened has invalid source shape');
        }
        assertRef(event.sourceRef, 'sourceRef');
        assertRef(event.ownerRef, 'ownerRef');
        assertInstant(event.incidentAt, 'incidentAt');
        assertInstant(event.discoveryAt, 'discoveryAt');
        if (Date.parse(event.discoveryAt) < Date.parse(event.incidentAt)) {
          throw new BreachCaseError('discoveryAt cannot precede incidentAt');
        }
        if (event.occurredAt !== event.discoveryAt) {
          throw new BreachCaseError('case-opened must occur at discoveryAt');
        }
        break;
      case 'scope-versioned':
        if (event.scope === undefined) throw new BreachCaseError('scope-versioned requires scope');
        if (event.scope.synthetic !== true || event.scope.version !== affectedScopes.length + 1) {
          throw new BreachCaseError('affected scope version/watermark mismatch');
        }
        if (event.occurredAt !== event.scope.recordedAt) {
          throw new BreachCaseError('affected scope event time mismatch');
        }
        if (
          JSON.stringify(event.scope.subjectRefs) !==
            JSON.stringify(uniqueSorted(event.scope.subjectRefs, 'subjectRef')) ||
          event.scope.contentHash !==
            hashScope({
              subjectRefs: [...new Set(event.scope.subjectRefs)].sort(),
              queryEvidenceRef: event.scope.queryEvidenceRef,
              windowStart: event.scope.windowStart,
              windowEnd: event.scope.windowEnd,
              complete: event.scope.complete,
              limitationRef: event.scope.limitationRef,
            })
        ) {
          throw new BreachCaseError('affected scope content hash mismatch');
        }
        for (const subjectRef of event.scope.subjectRefs) assertRef(subjectRef, 'subjectRef');
        assertRef(event.scope.queryEvidenceRef, 'queryEvidenceRef');
        assertInstant(event.scope.windowStart, 'windowStart');
        assertInstant(event.scope.windowEnd, 'windowEnd');
        assertInstant(event.scope.recordedAt, 'recordedAt');
        if (
          Date.parse(event.scope.windowEnd) < Date.parse(event.scope.windowStart) ||
          (event.scope.complete && event.scope.limitationRef !== null) ||
          (!event.scope.complete && event.scope.limitationRef === null)
        ) {
          throw new BreachCaseError('affected scope has invalid window/limitation truth');
        }
        if (event.scope.limitationRef !== null)
          assertRef(event.scope.limitationRef, 'limitationRef');
        affectedScopes = [...affectedScopes, event.scope];
        if (determination !== null) {
          determination = null;
          status = 'assessing';
        }
        break;
      case 'assessment-recorded':
        if (event.assessment === undefined)
          throw new BreachCaseError('assessment event requires assessment');
        validateAssessment(event.assessment, assessments.length + 1, affectedScopes.length);
        if (
          event.actorRef !== event.assessment.assessedBy ||
          event.occurredAt !== event.assessment.assessedAt
        ) {
          throw new BreachCaseError('assessment event attribution mismatch');
        }
        assessments = [...assessments, event.assessment];
        status = 'assessing';
        determination = null;
        break;
      case 'determination-recorded':
        if (event.determination === undefined)
          throw new BreachCaseError('determination event requires data');
        {
          const latestAssessment = assessments.at(-1);
          const latestScope = affectedScopes.at(-1);
          if (
            latestAssessment === undefined ||
            latestScope === undefined ||
            !latestScope.complete ||
            !assessmentIsKnown(latestAssessment) ||
            latestAssessment.scopeVersion !== latestScope.version ||
            event.determination.assessmentVersion !== latestAssessment.version ||
            !['reportable', 'low-probability'].includes(event.determination.kind) ||
            event.determination.determinedBy === event.determination.approvedBy ||
            event.actorRef !== event.determination.determinedBy ||
            event.occurredAt !== event.determination.determinedAt ||
            event.determination.synthetic !== true
          ) {
            throw new BreachCaseError(
              'determination does not match a current complete known scope assessment',
            );
          }
          assertRef(event.determination.rationaleRef, 'rationaleRef');
          assertRef(event.determination.determinedBy, 'determinedBy');
          assertRef(event.determination.approvedBy, 'approvedBy');
          assertInstant(event.determination.determinedAt, 'determinedAt');
        }
        determination = event.determination;
        status =
          event.determination.kind === 'reportable'
            ? 'determined-reportable'
            : 'determined-low-probability';
        break;
      case 'duty-linked':
      case 'duty-updated':
        if (event.duty === undefined) throw new BreachCaseError('duty event requires duty');
        validateDuty(event.duty);
        if (
          event.eventType === 'duty-linked' &&
          duties.some((duty) => duty.dutyId === event.duty?.dutyId)
        ) {
          throw new BreachCaseError('duty-linked cannot replace an existing duty');
        }
        if (event.eventType === 'duty-updated') {
          const priorDuty = duties.find((duty) => duty.dutyId === event.duty?.dutyId);
          if (priorDuty === undefined)
            throw new BreachCaseError('duty-updated requires existing duty');
          const allowed = new Set([
            'open:escalated',
            'open:satisfied',
            'open:cancelled',
            'escalated:satisfied',
            'escalated:cancelled',
          ]);
          if (!allowed.has(`${priorDuty.status}:${event.duty.status}`)) {
            throw new BreachCaseError('duty-updated has invalid status transition');
          }
          const immutablePrior = {
            ...priorDuty,
            status: event.duty.status,
            completionEvidenceRef: event.duty.completionEvidenceRef,
          };
          if (JSON.stringify(immutablePrior) !== JSON.stringify(event.duty)) {
            throw new BreachCaseError('duty-updated changed provider policy facts');
          }
        }
        duties = replaceById(duties, event.duty.dutyId, (item) => item.dutyId, event.duty);
        break;
      case 'notice-recorded':
        if (event.notice === undefined) throw new BreachCaseError('notice event requires notice');
        validateNotice(
          event.notice,
          notices.find((notice) => notice.noticeId === event.notice?.noticeId),
        );
        if (!duties.some((duty) => duty.dutyId === event.notice?.dutyId)) {
          throw new BreachCaseError('notice must name an applicable duty');
        }
        notices = replaceById(
          notices,
          event.notice.noticeId,
          (item) => item.noticeId,
          event.notice,
        );
        if (event.notice.state !== 'prepared') status = 'notifying';
        break;
      case 'evidence-linked':
        if (event.evidenceRef === undefined)
          throw new BreachCaseError('evidence event requires a ref');
        assertRef(event.evidenceRef, 'evidenceRef');
        if (event.retentionEvidenceRef !== undefined) {
          assertRef(event.retentionEvidenceRef, 'retentionEvidenceRef');
        }
        evidenceRefs = [...new Set([...evidenceRefs, event.evidenceRef])];
        if (event.retentionEvidenceRef !== undefined)
          retentionEvidenceRef = event.retentionEvidenceRef;
        break;
      case 'targeted-review-opened':
      case 'targeted-review-completed':
        if (event.geneticReview === undefined)
          throw new BreachCaseError('targeted review event requires data');
        if (event.geneticReview.synthetic !== true || event.geneticReview.risk !== 'critical') {
          throw new BreachCaseError('genetic targeted review has invalid risk/watermark');
        }
        for (const ref of [
          event.geneticReview.grantRef,
          event.geneticReview.auditRef,
          event.geneticReview.workItemRef,
          event.geneticReview.accessorRef,
          event.geneticReview.initiatorRef,
          event.geneticReview.subjectRef,
        ]) {
          assertRef(ref, 'genetic review ref');
        }
        assertInstant(event.geneticReview.reviewDueAt, 'reviewDueAt');
        assertInstant(event.geneticReview.sourceOccurredAt, 'sourceOccurredAt');
        if (event.eventType === 'targeted-review-opened') {
          if (
            geneticReviews.some((review) => review.reviewId === event.geneticReview?.reviewId) ||
            event.geneticReview.reviewerRef !== null ||
            event.geneticReview.completedAt !== null ||
            event.geneticReview.disposition !== null ||
            event.geneticReview.evidenceRef !== null
          ) {
            throw new BreachCaseError('targeted-review-opened has invalid initial shape');
          }
          if (event.occurredAt !== event.geneticReview.sourceOccurredAt) {
            throw new BreachCaseError('targeted review source time mismatch');
          }
        } else {
          const priorReview = geneticReviews.find(
            (review) => review.reviewId === event.geneticReview?.reviewId,
          );
          if (
            priorReview === undefined ||
            priorReview.reviewerRef !== null ||
            event.geneticReview.reviewerRef === null ||
            event.geneticReview.reviewerRef === priorReview.accessorRef ||
            event.geneticReview.reviewerRef === priorReview.initiatorRef ||
            event.geneticReview.disposition === null ||
            event.geneticReview.evidenceRef === null ||
            event.geneticReview.completedAt === null
          ) {
            throw new BreachCaseError('targeted-review-completed has invalid completion shape');
          }
          const immutablePrior = {
            ...priorReview,
            reviewerRef: event.geneticReview.reviewerRef,
            disposition: event.geneticReview.disposition,
            evidenceRef: event.geneticReview.evidenceRef,
            completedAt: event.geneticReview.completedAt,
          };
          if (JSON.stringify(immutablePrior) !== JSON.stringify(event.geneticReview)) {
            throw new BreachCaseError('targeted review completion changed source facts');
          }
        }
        geneticReviews = replaceById(
          geneticReviews,
          event.geneticReview.reviewId,
          (item) => item.reviewId,
          event.geneticReview,
        );
        break;
      case 'case-reopened':
        status = 'assessing';
        determination = null;
        break;
      case 'case-closed': {
        const latestAssessment = assessments.at(-1);
        const latestScope = affectedScopes.at(-1);
        if (
          determination === null ||
          latestAssessment === undefined ||
          latestScope === undefined ||
          !latestScope.complete ||
          !assessmentIsKnown(latestAssessment) ||
          latestAssessment.scopeVersion !== latestScope.version ||
          determination.assessmentVersion !== latestAssessment.version ||
          retentionEvidenceRef === null ||
          duties.length === 0 ||
          duties.some(
            (duty) =>
              !['satisfied', 'cancelled'].includes(duty.status) ||
              duty.completionEvidenceRef === null,
          ) ||
          geneticReviews.some(
            (review) => review.completedAt === null || review.evidenceRef === null,
          )
        ) {
          throw new BreachCaseError('case-closed event violates closure prerequisites');
        }
        if (
          determination.kind === 'reportable' &&
          duties.some((duty) =>
            duty.requiredAudiences.some(
              (audience) =>
                !notices.some(
                  (notice) =>
                    notice.dutyId === duty.dutyId &&
                    notice.audience === audience &&
                    notice.state === 'delivered' &&
                    notice.terminalEvidenceRef !== null,
                ),
            ),
          )
        ) {
          throw new BreachCaseError('case-closed event lacks delivered notice evidence');
        }
        status = 'closed';
        break;
      }
    }
  }
  return {
    tenantId: first.tenantId,
    caseId: first.caseId,
    sourceKind: first.sourceKind,
    sourceRef: first.sourceRef,
    incidentAt: first.incidentAt,
    discoveryAt: first.discoveryAt,
    ownerRef: first.ownerRef,
    status,
    assessments,
    affectedScopes,
    duties,
    notices,
    geneticReviews,
    evidenceRefs,
    retentionEvidenceRef,
    determination,
    strictestOpenDueAt: strictestOpenDue(duties),
    lastEventSeq: events.length,
    events: [...events],
    synthetic: true,
  };
}

export function openBreachCase(input: {
  readonly tenantId: string;
  readonly caseId: string;
  readonly sourceKind: BreachSourceKind;
  readonly sourceRef: string;
  readonly incidentAt: string;
  readonly discoveryAt: string;
  readonly ownerRef: string;
  readonly actorRef: string;
  readonly eventKey: string;
}): BreachCaseAggregate {
  assertId(input.tenantId, 'tenantId');
  assertId(input.caseId, 'caseId');
  assertRef(input.sourceRef, 'sourceRef');
  assertRef(input.ownerRef, 'ownerRef');
  assertRef(input.actorRef, 'actorRef');
  assertId(input.eventKey, 'eventKey');
  assertInstant(input.incidentAt, 'incidentAt');
  assertInstant(input.discoveryAt, 'discoveryAt');
  if (Date.parse(input.discoveryAt) < Date.parse(input.incidentAt)) {
    throw new BreachCaseError('discoveryAt cannot precede incidentAt');
  }
  return foldBreachCase([
    {
      ...input,
      eventSeq: 1,
      eventType: 'case-opened',
      occurredAt: input.discoveryAt,
      synthetic: true,
    },
  ]);
}

export function recordAffectedScope(
  aggregate: BreachCaseAggregate,
  input: Omit<AffectedScopeVersion, 'version' | 'subjectRefs' | 'contentHash' | 'synthetic'> & {
    readonly subjectRefs: readonly string[];
    readonly actorRef: string;
    readonly eventKey: string;
  },
): BreachCaseAggregate {
  const subjectRefs = uniqueSorted(input.subjectRefs, 'subjectRef');
  assertRef(input.queryEvidenceRef, 'queryEvidenceRef');
  if (input.complete && input.limitationRef !== null) {
    throw new BreachCaseError('a complete affected scope cannot carry a limitation');
  }
  if (!input.complete && input.limitationRef === null) {
    throw new BreachCaseError('an incomplete affected scope requires a limitation ref');
  }
  if (input.limitationRef !== null) assertRef(input.limitationRef, 'limitationRef');
  assertInstant(input.windowStart, 'windowStart');
  assertInstant(input.windowEnd, 'windowEnd');
  if (Date.parse(input.windowEnd) < Date.parse(input.windowStart)) {
    throw new BreachCaseError('affected-scope windowEnd cannot precede windowStart');
  }
  const version = aggregate.affectedScopes.length + 1;
  const hashInput = {
    subjectRefs,
    queryEvidenceRef: input.queryEvidenceRef,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    complete: input.complete,
    limitationRef: input.limitationRef,
  };
  const scope: AffectedScopeVersion = {
    ...hashInput,
    version,
    contentHash: hashScope(hashInput),
    recordedAt: input.recordedAt,
    synthetic: true,
  };
  const scopeEvent = nextEvent(aggregate, {
    eventKey: input.eventKey,
    eventType: 'scope-versioned',
    occurredAt: input.recordedAt,
    actorRef: input.actorRef,
    scope,
  });
  const updated = foldBreachCase([...aggregate.events, scopeEvent]);
  if (aggregate.determination === null) return updated;
  return foldBreachCase([
    ...updated.events,
    nextEvent(updated, {
      eventKey: `${input.eventKey}-reopen`,
      eventType: 'case-reopened',
      occurredAt: input.recordedAt,
      actorRef: input.actorRef,
      reasonRef: 'scope:widened',
    }),
  ]);
}

export function recordFourFactorAssessment(
  aggregate: BreachCaseAggregate,
  input: Omit<FourFactorAssessment, 'version' | 'scopeVersion' | 'complete' | 'synthetic'> & {
    readonly actorRef: string;
    readonly eventKey: string;
  },
): BreachCaseAggregate {
  const currentScope = aggregate.affectedScopes.at(-1);
  if (currentScope === undefined) throw new BreachCaseError('assessment requires affected scope');
  assertId(input.assessmentId, 'assessmentId');
  assertRef(input.assessedBy, 'assessedBy');
  assertInstant(input.assessedAt, 'assessedAt');
  const natureRefs = uniqueSorted(input.nature.phiCategoryRefs, 'phiCategoryRef');
  const natureEvidence = uniqueSorted(input.nature.evidenceRefs, 'natureEvidenceRef');
  const recipientEvidence = uniqueSorted(input.recipient.evidenceRefs, 'recipientEvidenceRef');
  const acquisitionEvidence = uniqueSorted(
    input.acquisition.evidenceRefs,
    'acquisitionEvidenceRef',
  );
  const mitigationActions = uniqueSorted(input.mitigation.actionRefs, 'mitigationActionRef');
  const mitigationEvidence = uniqueSorted(input.mitigation.evidenceRefs, 'mitigationEvidenceRef');
  if (input.recipient.relationshipRef !== null)
    assertRef(input.recipient.relationshipRef, 'relationshipRef');
  const complete =
    natureRefs.length > 0 &&
    natureEvidence.length > 0 &&
    recipientEvidence.length > 0 &&
    acquisitionEvidence.length > 0 &&
    mitigationEvidence.length > 0;
  const assessment: FourFactorAssessment = {
    assessmentId: input.assessmentId,
    version: aggregate.assessments.length + 1,
    scopeVersion: currentScope.version,
    assessedAt: input.assessedAt,
    assessedBy: input.assessedBy,
    nature: { ...input.nature, phiCategoryRefs: natureRefs, evidenceRefs: natureEvidence },
    recipient: { ...input.recipient, evidenceRefs: recipientEvidence },
    acquisition: { ...input.acquisition, evidenceRefs: acquisitionEvidence },
    mitigation: {
      ...input.mitigation,
      actionRefs: mitigationActions,
      evidenceRefs: mitigationEvidence,
    },
    complete,
    synthetic: true,
  };
  return foldBreachCase([
    ...aggregate.events,
    nextEvent(aggregate, {
      eventKey: input.eventKey,
      eventType: 'assessment-recorded',
      occurredAt: input.assessedAt,
      actorRef: input.actorRef,
      assessment,
    }),
  ]);
}

export function recordDetermination(
  aggregate: BreachCaseAggregate,
  input: Omit<BreachDetermination, 'assessmentVersion' | 'synthetic'> & {
    readonly eventKey: string;
  },
): BreachCaseAggregate {
  const assessment = aggregate.assessments.at(-1);
  const scope = aggregate.affectedScopes.at(-1);
  if (
    assessment === undefined ||
    scope === undefined ||
    !scope.complete ||
    assessment.scopeVersion !== scope.version ||
    !assessmentIsKnown(assessment)
  ) {
    throw new BreachCaseError(
      'determination requires a complete four-factor assessment with no unknown factor',
    );
  }
  assertRef(input.rationaleRef, 'rationaleRef');
  assertRef(input.determinedBy, 'determinedBy');
  assertRef(input.approvedBy, 'approvedBy');
  assertInstant(input.determinedAt, 'determinedAt');
  if (input.determinedBy === input.approvedBy) {
    throw new BreachCaseError('determination requires a distinct human approver');
  }
  const determination: BreachDetermination = {
    ...input,
    assessmentVersion: assessment.version,
    synthetic: true,
  };
  return foldBreachCase([
    ...aggregate.events,
    nextEvent(aggregate, {
      eventKey: input.eventKey,
      eventType: 'determination-recorded',
      occurredAt: input.determinedAt,
      actorRef: input.determinedBy,
      determination,
    }),
  ]);
}

export function linkJurisdictionDuty(
  aggregate: BreachCaseAggregate,
  duty: JurisdictionDuty,
  actorRef: string,
  eventKey: string,
  occurredAt: string,
): BreachCaseAggregate {
  validateDuty(duty);
  const prior = aggregate.duties.find((item) => item.dutyId === duty.dutyId);
  if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(duty)) {
    throw new BreachCaseError('duty id was reused with changed intent');
  }
  if (prior !== undefined) return aggregate;
  return foldBreachCase([
    ...aggregate.events,
    nextEvent(aggregate, {
      eventKey,
      eventType: 'duty-linked',
      occurredAt,
      actorRef,
      duty,
    }),
  ]);
}

export function updateJurisdictionDuty(
  aggregate: BreachCaseAggregate,
  dutyId: string,
  status: DutyStatus,
  completionEvidenceRef: string | null,
  actorRef: string,
  eventKey: string,
  occurredAt: string,
): BreachCaseAggregate {
  const prior = aggregate.duties.find((item) => item.dutyId === dutyId);
  if (prior === undefined) throw new BreachCaseError('cannot update an unknown jurisdiction duty');
  if (prior.status === status && prior.completionEvidenceRef === completionEvidenceRef)
    return aggregate;
  const allowed = new Set<string>([
    'open:escalated',
    'open:satisfied',
    'open:cancelled',
    'escalated:satisfied',
    'escalated:cancelled',
  ]);
  if (!allowed.has(`${prior.status}:${status}`)) {
    throw new BreachCaseError(`invalid jurisdiction duty transition ${prior.status} -> ${status}`);
  }
  if ((status === 'satisfied' || status === 'cancelled') && completionEvidenceRef === null) {
    throw new BreachCaseError('completed duty requires provider evidence');
  }
  const duty: JurisdictionDuty = { ...prior, status, completionEvidenceRef };
  validateDuty(duty);
  return foldBreachCase([
    ...aggregate.events,
    nextEvent(aggregate, {
      eventKey,
      eventType: 'duty-updated',
      occurredAt,
      actorRef,
      duty,
    }),
  ]);
}

export function recordNotice(
  aggregate: BreachCaseAggregate,
  notice: NotificationEvidence,
  actorRef: string,
  eventKey: string,
  occurredAt: string,
): BreachCaseAggregate {
  const duty = aggregate.duties.find((item) => item.dutyId === notice.dutyId);
  if (duty === undefined) throw new BreachCaseError('notice must name an applicable duty');
  const prior = aggregate.notices.find((item) => item.noticeId === notice.noticeId);
  validateNotice(notice, prior);
  if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(notice)) return aggregate;
  return foldBreachCase([
    ...aggregate.events,
    nextEvent(aggregate, {
      eventKey,
      eventType: 'notice-recorded',
      occurredAt,
      actorRef,
      notice,
    }),
  ]);
}

export function linkRetentionEvidence(
  aggregate: BreachCaseAggregate,
  evidenceRef: string,
  retentionEvidenceRef: string,
  actorRef: string,
  eventKey: string,
  occurredAt: string,
): BreachCaseAggregate {
  assertRef(evidenceRef, 'evidenceRef');
  assertRef(retentionEvidenceRef, 'retentionEvidenceRef');
  return foldBreachCase([
    ...aggregate.events,
    nextEvent(aggregate, {
      eventKey,
      eventType: 'evidence-linked',
      occurredAt,
      actorRef,
      evidenceRef,
      retentionEvidenceRef,
    }),
  ]);
}

export interface GeneticElevationSourceRecord {
  readonly tenantId: string;
  readonly sourceEventKey: string;
  readonly grantRef: string;
  readonly auditRef: string;
  readonly workItemRef: string;
  readonly accessorRef: string;
  readonly initiatorRef: string;
  readonly subjectRef: string;
  readonly severity: 'standard' | 'elevated-genetic';
  readonly partitionTags: readonly string[];
  readonly reviewDueAt: string;
  readonly occurredAt: string;
  readonly synthetic: true;
}

export function openGeneticTargetedReview(
  aggregate: BreachCaseAggregate,
  source: GeneticElevationSourceRecord,
  actorRef: string,
): BreachCaseAggregate {
  if (source.tenantId !== aggregate.tenantId)
    throw new BreachCaseError('genetic source tenant mismatch');
  assertId(source.sourceEventKey, 'sourceEventKey');
  if (source.synthetic !== true) throw new BreachCaseError('genetic source must be synthetic');
  if (source.severity !== 'elevated-genetic' || !source.partitionTags.includes('gipa-genetic')) {
    throw new BreachCaseError('targeted review requires exact elevated-genetic GIPA source');
  }
  for (const ref of [
    source.grantRef,
    source.auditRef,
    source.workItemRef,
    source.accessorRef,
    source.initiatorRef,
    source.subjectRef,
  ]) {
    assertRef(ref, 'genetic source ref');
  }
  assertInstant(source.reviewDueAt, 'reviewDueAt');
  assertInstant(source.occurredAt, 'source occurredAt');
  const reviewId = `genetic-review-${source.sourceEventKey}`;
  const review: GeneticTargetedReview = {
    reviewId,
    grantRef: source.grantRef,
    auditRef: source.auditRef,
    workItemRef: source.workItemRef,
    accessorRef: source.accessorRef,
    initiatorRef: source.initiatorRef,
    subjectRef: source.subjectRef,
    reviewDueAt: source.reviewDueAt,
    sourceOccurredAt: source.occurredAt,
    risk: 'critical',
    reviewerRef: null,
    disposition: null,
    evidenceRef: null,
    completedAt: null,
    synthetic: true,
  };
  const prior = aggregate.geneticReviews.find((item) => item.reviewId === reviewId);
  if (prior !== undefined) {
    const immutableMatches =
      prior.grantRef === review.grantRef &&
      prior.auditRef === review.auditRef &&
      prior.workItemRef === review.workItemRef &&
      prior.accessorRef === review.accessorRef &&
      prior.initiatorRef === review.initiatorRef &&
      prior.subjectRef === review.subjectRef &&
      prior.reviewDueAt === review.reviewDueAt &&
      prior.sourceOccurredAt === review.sourceOccurredAt &&
      prior.risk === review.risk;
    if (!immutableMatches) {
      throw new BreachCaseError('genetic source key was reused with changed correlation');
    }
    return aggregate;
  }
  return foldBreachCase([
    ...aggregate.events,
    nextEvent(aggregate, {
      eventKey: source.sourceEventKey,
      eventType: 'targeted-review-opened',
      occurredAt: source.occurredAt,
      actorRef,
      geneticReview: review,
    }),
  ]);
}

export function completeGeneticTargetedReview(
  aggregate: BreachCaseAggregate,
  input: {
    readonly reviewId: string;
    readonly reviewerRef: string;
    readonly disposition: 'appropriate' | 'insufficient-justification';
    readonly evidenceRef: string;
    readonly completedAt: string;
    readonly eventKey: string;
  },
): BreachCaseAggregate {
  const review = aggregate.geneticReviews.find((item) => item.reviewId === input.reviewId);
  if (review === undefined) throw new BreachCaseError('unknown genetic targeted review');
  if (review.reviewerRef !== null)
    throw new BreachCaseError('genetic targeted review is already complete');
  if (input.reviewerRef === review.accessorRef || input.reviewerRef === review.initiatorRef) {
    throw new BreachCaseError('genetic targeted review requires an independent reviewer');
  }
  assertRef(input.reviewerRef, 'reviewerRef');
  assertRef(input.evidenceRef, 'evidenceRef');
  assertInstant(input.completedAt, 'completedAt');
  const completed: GeneticTargetedReview = {
    ...review,
    reviewerRef: input.reviewerRef,
    disposition: input.disposition,
    evidenceRef: input.evidenceRef,
    completedAt: input.completedAt,
  };
  return foldBreachCase([
    ...aggregate.events,
    nextEvent(aggregate, {
      eventKey: input.eventKey,
      eventType: 'targeted-review-completed',
      occurredAt: input.completedAt,
      actorRef: input.reviewerRef,
      geneticReview: completed,
    }),
  ]);
}

export function closeBreachCase(
  aggregate: BreachCaseAggregate,
  input: {
    readonly actorRef: string;
    readonly occurredAt: string;
    readonly evidenceRef: string;
    readonly eventKey: string;
  },
): BreachCaseAggregate {
  const assessment = aggregate.assessments.at(-1);
  const currentScope = aggregate.affectedScopes.at(-1);
  if (
    assessment === undefined ||
    !assessmentIsKnown(assessment) ||
    aggregate.determination === null
  ) {
    throw new BreachCaseError('closure requires a complete known assessment and determination');
  }
  if (
    currentScope === undefined ||
    !currentScope.complete ||
    assessment.scopeVersion !== currentScope.version ||
    aggregate.determination.assessmentVersion !== assessment.version
  ) {
    throw new BreachCaseError(
      'closure requires determination for the current complete scope assessment',
    );
  }
  if (aggregate.retentionEvidenceRef === null)
    throw new BreachCaseError('closure requires retention evidence');
  if (aggregate.duties.length === 0)
    throw new BreachCaseError('closure requires jurisdiction duties');
  if (
    aggregate.duties.some(
      (duty) =>
        !['satisfied', 'cancelled'].includes(duty.status) || duty.completionEvidenceRef === null,
    )
  ) {
    throw new BreachCaseError('closure requires provider evidence for every jurisdiction duty');
  }
  if (aggregate.determination.kind === 'reportable') {
    for (const duty of aggregate.duties) {
      for (const audience of duty.requiredAudiences) {
        if (
          !aggregate.notices.some(
            (notice) =>
              notice.dutyId === duty.dutyId &&
              notice.audience === audience &&
              notice.state === 'delivered' &&
              notice.terminalEvidenceRef !== null,
          )
        ) {
          throw new BreachCaseError(
            'reportable closure requires terminal notice evidence for every required audience',
          );
        }
      }
    }
  }
  if (
    aggregate.geneticReviews.some(
      (review) => review.completedAt === null || review.evidenceRef === null,
    )
  ) {
    throw new BreachCaseError('closure requires every genetic targeted review to complete');
  }
  assertRef(input.evidenceRef, 'closureEvidenceRef');
  return foldBreachCase([
    ...aggregate.events,
    nextEvent(aggregate, {
      eventKey: input.eventKey,
      eventType: 'case-closed',
      occurredAt: input.occurredAt,
      actorRef: input.actorRef,
      evidenceRef: input.evidenceRef,
    }),
  ]);
}
