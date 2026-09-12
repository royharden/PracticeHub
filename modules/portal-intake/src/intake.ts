import { createHash } from 'node:crypto';

import { validateHealthAnswers, validateSubmittedFields } from './intake-definition.js';
import {
  IntakeError,
  type AnonymousAbandonmentMetric,
  type CollectionConsentEvent,
  type IntakeDefinition,
  type IntakeRecord,
} from './intake-types.js';
import type {
  IntakeAttemptPort,
  IntakeRecordPort,
  IntakeUploadPort,
  IntakeWorkItemPort,
} from './ports.js';

const sha256 = /^[0-9a-f]{64}$/;
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function instant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (
    !iso.test(value) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString().replace('.000', '') !== value
  ) {
    throw new IntakeError(`${label} must be a real UTC instant`);
  }
  return parsed;
}

export function collectionConsentEvidenceHash(input: {
  readonly intakeRef: string;
  readonly prospectRef: string;
  readonly decision: 'granted' | 'declined';
  readonly quizVersion: string;
  readonly noticeVersion: string;
  readonly embeddingOrigin: string;
  readonly occurredAt: string;
}): string {
  const evidence = {
    intakeRef: input.intakeRef,
    prospectRef: input.prospectRef,
    decision: input.decision,
    quizVersion: input.quizVersion,
    noticeVersion: input.noticeVersion,
    embeddingOrigin: input.embeddingOrigin,
    occurredAt: input.occurredAt,
  };
  return createHash('sha256').update(JSON.stringify(evidence), 'utf8').digest('hex');
}

export function appendCollectionConsentEvent(
  log: readonly CollectionConsentEvent[],
  event: CollectionConsentEvent,
): readonly CollectionConsentEvent[] {
  instant(event.occurredAt, 'collection consent time');
  if (!sha256.test(event.evidenceHash))
    throw new IntakeError('collection consent requires evidence hash');
  if (event.purpose !== 'quiz-collection')
    throw new IntakeError('collection consent cannot imply treatment or marketing');
  if (log.some((entry) => entry.eventId === event.eventId)) {
    const prior = log.find((entry) => entry.eventId === event.eventId) as CollectionConsentEvent;
    if (JSON.stringify(prior) !== JSON.stringify(event))
      throw new IntakeError('consent event id replay changed evidence');
    return log;
  }
  if (event.sourceEventId !== undefined) {
    const source = log.find((entry) => entry.eventId === event.sourceEventId);
    if (
      source === undefined ||
      source.decision !== 'granted' ||
      source.tenantId !== event.tenantId ||
      source.intakeRef !== event.intakeRef ||
      source.prospectRef !== event.prospectRef ||
      source.quizVersion !== event.quizVersion ||
      source.noticeVersion !== event.noticeVersion ||
      source.embeddingOrigin !== event.embeddingOrigin ||
      source.evidenceRef !== event.evidenceRef ||
      source.evidenceHash !== event.evidenceHash
    ) {
      throw new IntakeError('subject link must preserve exact source consent evidence');
    }
    if (Date.parse(event.occurredAt) < Date.parse(source.occurredAt))
      throw new IntakeError('subject link cannot predate source consent');
  }
  return [...log, event];
}

export function linkCollectionConsentToPerson(
  log: readonly CollectionConsentEvent[],
  sourceEventId: string,
  linkEventId: string,
  governedPersonRef: string,
  occurredAt: string,
): readonly CollectionConsentEvent[] {
  const source = log.find((entry) => entry.eventId === sourceEventId);
  if (source === undefined || source.decision !== 'granted')
    throw new IntakeError('granted source consent is required');
  return appendCollectionConsentEvent(log, {
    ...source,
    eventId: linkEventId,
    governedPersonRef,
    sourceEventId,
    occurredAt,
  });
}

export async function linkAndPersistCollectionConsentToPerson(
  records: IntakeRecordPort,
  log: readonly CollectionConsentEvent[],
  sourceEventId: string,
  linkEventId: string,
  governedPersonRef: string,
  occurredAt: string,
): Promise<readonly CollectionConsentEvent[]> {
  const linked = linkCollectionConsentToPerson(
    log,
    sourceEventId,
    linkEventId,
    governedPersonRef,
    occurredAt,
  );
  await records.appendSubjectLink(linked[linked.length - 1] as CollectionConsentEvent);
  return linked;
}

export function anonymousAbandonment(input: {
  readonly tenantId: string;
  readonly definitionVersion: string;
  readonly occurredAt: string;
  readonly reason: AnonymousAbandonmentMetric['reason'];
}): AnonymousAbandonmentMetric {
  return { ...input, synthetic: true };
}

export function abandonIntake(input: {
  readonly tenantId: string;
  readonly definitionVersion: string;
  readonly retainedUntil: string;
  readonly at: string;
  readonly optionalHealthBuffer: Readonly<Record<string, string>>;
}): {
  readonly cleaned: boolean;
  readonly optionalHealthBuffer: Readonly<Record<string, string>>;
  readonly metric?: AnonymousAbandonmentMetric;
} {
  const at = instant(input.at, 'abandonment time');
  const retainedUntil = instant(input.retainedUntil, 'retention boundary');
  if (at < retainedUntil) {
    return { cleaned: false, optionalHealthBuffer: { ...input.optionalHealthBuffer } };
  }
  return {
    cleaned: true,
    optionalHealthBuffer: {},
    metric: anonymousAbandonment({
      tenantId: input.tenantId,
      definitionVersion: input.definitionVersion,
      occurredAt: input.at,
      reason: 'retention-expired',
    }),
  };
}

export interface SubmitIntakeInput {
  readonly tenantId: string;
  readonly intakeRef: string;
  readonly prospectRef: string;
  readonly definition: IntakeDefinition;
  readonly channel: 'primary-web' | 'embedded-web' | 'staff-assisted';
  readonly embeddingOrigin: string;
  readonly explicitConsentControl: boolean;
  readonly collectionConsent: CollectionConsentEvent;
  readonly fields: Readonly<Record<string, string>>;
  readonly healthAnswers: Readonly<Record<string, string>>;
  readonly attemptKey: string;
  readonly attachments?: readonly {
    readonly documentRef: string;
    readonly bytes: string;
    readonly mediaType: string;
    readonly pageCount: number;
  }[];
  readonly responseDueAt: string;
  readonly ownerRef: string;
  readonly occurredAt: string;
  readonly synthetic: true;
}

export type SubmitIntakeResult =
  | {
      readonly outcome: 'declined';
      readonly metric: AnonymousAbandonmentMetric;
      readonly persistedHealthValues: readonly [];
    }
  | {
      readonly outcome: 'submitted';
      readonly record: IntakeRecord;
      readonly consentLog: readonly CollectionConsentEvent[];
    };

export async function submitIntake(
  workItems: IntakeWorkItemPort,
  uploads: IntakeUploadPort,
  attempts: IntakeAttemptPort,
  records: IntakeRecordPort,
  input: SubmitIntakeInput,
): Promise<SubmitIntakeResult> {
  const submittedAt = instant(input.occurredAt, 'submission time');
  const responseDueAt = instant(input.responseDueAt, 'response due time');
  const consentAt = instant(input.collectionConsent.occurredAt, 'collection consent time');
  if (consentAt > submittedAt)
    throw new IntakeError('submission cannot predate collection consent');
  if (responseDueAt <= submittedAt)
    throw new IntakeError('response due time must follow submission');
  if (
    input.collectionConsent.tenantId !== input.tenantId ||
    input.collectionConsent.intakeRef !== input.intakeRef ||
    input.collectionConsent.prospectRef !== input.prospectRef ||
    input.collectionConsent.embeddingOrigin !== input.embeddingOrigin
  ) {
    throw new IntakeError('collection consent scope does not match intake context');
  }
  if (input.collectionConsent.quizVersion !== input.definition.version)
    throw new IntakeError('consent quiz version mismatch');
  const expectedHash = collectionConsentEvidenceHash(input.collectionConsent);
  if (input.collectionConsent.evidenceHash !== expectedHash)
    throw new IntakeError('collection consent evidence hash mismatch');
  if (input.channel === 'embedded-web' && !input.explicitConsentControl) {
    throw new IntakeError('embedded context cannot bypass the explicit consent control');
  }
  if (!input.explicitConsentControl || input.collectionConsent.decision === 'declined') {
    return {
      outcome: 'declined',
      metric: anonymousAbandonment({
        tenantId: input.tenantId,
        definitionVersion: input.definition.version,
        occurredAt: input.occurredAt,
        reason: 'collection-consent-declined',
      }),
      persistedHealthValues: [],
    };
  }
  const consentLog = appendCollectionConsentEvent([], input.collectionConsent);
  const fields = validateSubmittedFields(input.definition, input.fields);
  const healthAnswers = validateHealthAnswers(input.definition, input.healthAnswers);
  await records.appendCollectionConsent(input.collectionConsent);
  const urgent = fields['urgency-screen'] === 'emergency';
  const inputHash = createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
  let attempt = await attempts.load(input.attemptKey);
  if (attempt !== null && attempt.inputHash !== inputHash)
    throw new IntakeError('intake retry changed input');
  attempt ??= {
    attemptKey: input.attemptKey,
    inputHash,
    consentEventId: input.collectionConsent.eventId,
    attachments: [],
    state: 'consented',
    synthetic: true,
  };
  await attempts.save(attempt);
  const attachmentReceipts = [...attempt.attachments];
  for (const attachment of (input.attachments ?? []).slice(attachmentReceipts.length)) {
    const result = await uploads.receive({
      tenantId: input.tenantId,
      intakeRef: input.intakeRef,
      ...attachment,
      actorRef: 'synthetic-system:portal-intake',
      occurredAt: input.occurredAt,
      synthetic: true,
    });
    if (result.kind !== 'quarantined') throw new IntakeError('portal upload must enter quarantine');
    if (
      result.blobRef !== `blob://documents/${result.contentHash}` ||
      result.observedAttributeNames.some(
        (name) =>
          ![
            'patient-name',
            'date-of-birth',
            'address',
            'phone',
            'mrn',
            'ssn-last4',
            'member-id',
            'sender-fax',
            'account-number',
          ].includes(name),
      )
    ) {
      throw new IntakeError('upload provider returned unsafe quarantine metadata');
    }
    attachmentReceipts.push({
      documentRef: result.documentRef,
      blobRef: result.blobRef,
      contentHash: result.contentHash,
      observedAttributeNames: result.observedAttributeNames,
    });
    attempt = { ...attempt, attachments: [...attachmentReceipts] };
    await attempts.save(attempt);
  }
  if (attempt.state !== 'complete') {
    attempt = { ...attempt, state: 'uploads-reconciled' };
    await attempts.save(attempt);
  }
  const task =
    attempt.workItemRef === undefined
      ? await workItems.open({
          tenantId: input.tenantId,
          intakeRef: input.intakeRef,
          purpose: urgent ? 'urgent-intake-review' : 'prospective-intake',
          risk: urgent ? 'urgent' : 'routine',
          responseDueAt: input.responseDueAt,
          ownerRef: input.ownerRef,
          poolRef: urgent ? 'clinical-intake' : 'prospect-intake',
          occurredAt: input.occurredAt,
        })
      : {
          workItemRef: attempt.workItemRef,
          responseDueAt: attempt.responseDueAt as string,
          visibleStatus: attempt.status as 'submitted' | 'urgent-review',
        };
  if (attempt.state !== 'complete') {
    attempt = {
      ...attempt,
      workItemRef: task.workItemRef,
      responseDueAt: task.responseDueAt,
      status: task.visibleStatus,
      state: 'complete',
    };
    await attempts.save(attempt);
  }
  const record: IntakeRecord = {
    tenantId: input.tenantId,
    intakeRef: input.intakeRef,
    prospectRef: input.prospectRef,
    definitionVersion: input.definition.version,
    channel: input.channel,
    fields,
    healthAnswers,
    collectionConsentEventId: input.collectionConsent.eventId,
    collectionConsentEvidenceRef: input.collectionConsent.evidenceRef,
    collectionConsentEvidenceHash: input.collectionConsent.evidenceHash,
    workItemRef: task.workItemRef,
    responseDueAt: task.responseDueAt,
    submittedAt: input.occurredAt,
    status: task.visibleStatus,
    attachments: attachmentReceipts,
    synthetic: true,
  };
  await records.saveSubmission(record);
  return { outcome: 'submitted', consentLog, record };
}
