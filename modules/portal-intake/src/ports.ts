import type { BlobStore, DocumentEvent } from '@practicehub/documents';
import {
  appendDocumentEvent,
  hashContent,
  receiveDocument,
  verifyBlobIntegrity,
} from '@practicehub/documents';
import type { Queryable } from '@practicehub/events';
import { appendEvents, loadWorkItem, openWorkItem } from '@practicehub/events';
import type {
  AuthChallenge,
  ElevatedLink,
  ElevationBasis,
  PreAuthSession,
} from '@practicehub/identity';
import { completeElevation, declineOrFailElevation } from '@practicehub/identity';

import {
  IntakeError,
  type CollectionConsentEvent,
  type IntakeAttempt,
  type IntakeRecord,
} from './intake-types.js';

export interface IntakeIdentityPort {
  elevate(
    preAuth: PreAuthSession,
    basis: ElevationBasis,
  ):
    | { readonly kind: 'verified'; readonly link: ElevatedLink }
    | {
        readonly kind: 'withheld';
        readonly humanPath: true;
        readonly secureChannelPath: true;
      };
}

export interface IntakeUploadResult {
  readonly kind: 'quarantined';
  readonly documentRef: string;
  readonly blobRef: string;
  readonly contentHash: string;
  readonly observedAttributeNames: readonly string[];
}

export interface IntakeUploadPort {
  receive(input: {
    readonly tenantId: string;
    readonly intakeRef: string;
    readonly documentRef: string;
    readonly bytes: string;
    readonly mediaType: string;
    readonly pageCount: number;
    readonly actorRef: string;
    readonly occurredAt: string;
    readonly synthetic: true;
  }): Promise<IntakeUploadResult>;
}

export interface IntakeAttemptPort {
  load(attemptKey: string): Promise<IntakeAttempt | null>;
  save(attempt: IntakeAttempt): Promise<void>;
}

export interface IntakeRecordPort {
  appendCollectionConsent(event: CollectionConsentEvent): Promise<void>;
  appendSubjectLink(event: CollectionConsentEvent): Promise<void>;
  saveSubmission(record: IntakeRecord): Promise<void>;
}

export class PracticeHubIntakeRepository implements IntakeRecordPort {
  public constructor(private readonly exec: Queryable) {}

  public async appendCollectionConsent(event: CollectionConsentEvent): Promise<void> {
    const result = await this.exec.query(
      `INSERT INTO portal_intake.intake_event
         (tenant_id,event_id,intake_ref,prospect_ref,event_type,purpose,quiz_version,notice_version,
          embedding_origin,evidence_ref,evidence_hash,occurred_at,synthetic)
       VALUES ($1,$2,$3,$4,$5,'quiz-collection',$6,$7,$8,$9,$10,$11,true)
       ON CONFLICT (tenant_id,event_id) DO NOTHING`,
      [
        event.tenantId,
        event.eventId,
        event.intakeRef,
        event.prospectRef,
        event.decision === 'granted' ? 'collection-consent-granted' : 'collection-consent-declined',
        event.quizVersion,
        event.noticeVersion,
        event.embeddingOrigin,
        event.evidenceRef,
        event.evidenceHash,
        event.occurredAt,
      ],
    );
    if (result.rowCount === 0) {
      const prior = await this.exec.query(
        `SELECT intake_ref,prospect_ref,quiz_version,embedding_origin,evidence_ref,evidence_hash
           FROM portal_intake.intake_event WHERE tenant_id=$1 AND event_id=$2`,
        [event.tenantId, event.eventId],
      );
      const row = prior.rows[0];
      if (
        row === undefined ||
        String(row['intake_ref']) !== event.intakeRef ||
        String(row['prospect_ref']) !== event.prospectRef ||
        String(row['quiz_version']) !== event.quizVersion ||
        String(row['embedding_origin']) !== event.embeddingOrigin ||
        String(row['evidence_ref']) !== event.evidenceRef ||
        String(row['evidence_hash']) !== event.evidenceHash
      ) {
        throw new IntakeError('persisted consent retry changed evidence');
      }
    }
  }

  public async appendSubjectLink(event: CollectionConsentEvent): Promise<void> {
    if (event.sourceEventId === undefined || event.governedPersonRef === undefined) {
      throw new IntakeError('subject link requires source consent and governed person');
    }
    await this.exec.query(
      `INSERT INTO portal_intake.intake_event
         (tenant_id,event_id,intake_ref,prospect_ref,event_type,purpose,quiz_version,notice_version,
          embedding_origin,evidence_ref,evidence_hash,governed_person_ref,source_event_id,occurred_at,synthetic)
       VALUES ($1,$2,$3,$4,'subject-linked','quiz-collection',$5,$6,$7,$8,$9,$10,$11,$12,true)
       ON CONFLICT (tenant_id,event_id) DO NOTHING`,
      [
        event.tenantId,
        event.eventId,
        event.intakeRef,
        event.prospectRef,
        event.quizVersion,
        event.noticeVersion,
        event.embeddingOrigin,
        event.evidenceRef,
        event.evidenceHash,
        event.governedPersonRef,
        event.sourceEventId,
        event.occurredAt,
      ],
    );
  }

  public async saveSubmission(record: IntakeRecord): Promise<void> {
    await this.exec.query(
      `INSERT INTO portal_intake.intake_submission
         (tenant_id,intake_ref,prospect_ref,governed_person_ref,definition_id,definition_version,
          status,work_item_ref,response_due_at,submitted_at,last_event_id,synthetic)
       VALUES ($1,$2,$3,$4,'prospective-intake',$5,$6,$7,$8,$9,$10,true)
       ON CONFLICT (tenant_id,intake_ref) DO UPDATE SET status=EXCLUDED.status,
         work_item_ref=EXCLUDED.work_item_ref,response_due_at=EXCLUDED.response_due_at,
         last_event_id=EXCLUDED.last_event_id`,
      [
        record.tenantId,
        record.intakeRef,
        record.prospectRef,
        record.governedPersonRef ?? null,
        record.definitionVersion,
        record.status,
        record.workItemRef,
        record.responseDueAt,
        record.submittedAt,
        record.collectionConsentEventId,
      ],
    );
    for (const [fieldId, answerValue] of Object.entries(record.healthAnswers)) {
      const answerId = `answer-${hashContent(`${record.intakeRef.length}:${record.intakeRef}|${fieldId}`).slice(0, 32)}`;
      await this.exec.query(
        `INSERT INTO portal_intake.intake_answer
           (tenant_id,answer_id,intake_ref,field_id,answer_value,respondent_ref,respondent_role,
            source_channel,captured_at,synthetic)
         VALUES ($1,$2,$3,$4,$5,$6,'prospect',$7,$8,true)
         ON CONFLICT (tenant_id,answer_id) DO NOTHING`,
        [
          record.tenantId,
          answerId,
          record.intakeRef,
          fieldId,
          answerValue,
          record.prospectRef,
          record.channel,
          record.submittedAt,
        ],
      );
    }
    for (const attachment of record.attachments) {
      const attachmentId = `attachment-${hashContent(`${record.intakeRef.length}:${record.intakeRef}|${attachment.documentRef}`).slice(0, 32)}`;
      await this.exec.query(
        `INSERT INTO portal_intake.intake_attachment
           (tenant_id,attachment_id,intake_ref,document_ref,blob_ref,content_hash,status,
            observed_attribute_names,synthetic)
         VALUES ($1,$2,$3,$4,$5,$6,'quarantined',$7,true)
         ON CONFLICT (tenant_id,attachment_id) DO NOTHING`,
        [
          record.tenantId,
          attachmentId,
          record.intakeRef,
          attachment.documentRef,
          attachment.blobRef,
          attachment.contentHash,
          attachment.observedAttributeNames,
        ],
      );
    }
  }
}

export class PracticeHubIntakeAttemptAdapter implements IntakeAttemptPort {
  public constructor(
    private readonly exec: Queryable,
    private readonly tenantId: string,
  ) {}
  public async load(attemptKey: string): Promise<IntakeAttempt | null> {
    const result = await this.exec.query(
      `SELECT attempt_key,input_hash,consent_event_id,attachment_receipts,work_item_ref,
              response_due_at,status,state
         FROM portal_intake.intake_attempt WHERE tenant_id=$1 AND attempt_key=$2`,
      [this.tenantId, attemptKey],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      attemptKey: String(row['attempt_key']),
      inputHash: String(row['input_hash']),
      consentEventId: String(row['consent_event_id']),
      attachments: row['attachment_receipts'] as IntakeAttempt['attachments'],
      ...(row['work_item_ref'] === null ? {} : { workItemRef: String(row['work_item_ref']) }),
      ...(row['response_due_at'] === null
        ? {}
        : {
            responseDueAt:
              row['response_due_at'] instanceof Date
                ? row['response_due_at'].toISOString().replace('.000', '')
                : String(row['response_due_at']),
          }),
      ...(row['status'] === null ? {} : { status: row['status'] as 'submitted' | 'urgent-review' }),
      state: row['state'] as IntakeAttempt['state'],
      synthetic: true,
    };
  }
  public async save(attempt: IntakeAttempt): Promise<void> {
    const result = await this.exec.query(
      `INSERT INTO portal_intake.intake_attempt
         (tenant_id,attempt_key,input_hash,consent_event_id,attachment_receipts,work_item_ref,response_due_at,status,state,synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
       ON CONFLICT (tenant_id,attempt_key) DO UPDATE SET
         attachment_receipts=EXCLUDED.attachment_receipts, work_item_ref=EXCLUDED.work_item_ref,
         response_due_at=EXCLUDED.response_due_at, status=EXCLUDED.status, state=EXCLUDED.state
       WHERE portal_intake.intake_attempt.input_hash=EXCLUDED.input_hash
         AND portal_intake.intake_attempt.consent_event_id=EXCLUDED.consent_event_id
         AND jsonb_array_length(portal_intake.intake_attempt.attachment_receipts)
             <= jsonb_array_length(EXCLUDED.attachment_receipts)
         AND EXCLUDED.attachment_receipts @> portal_intake.intake_attempt.attachment_receipts
         AND CASE portal_intake.intake_attempt.state
               WHEN 'consented' THEN 1 WHEN 'uploads-reconciled' THEN 2 WHEN 'complete' THEN 3 END
             <= CASE EXCLUDED.state
               WHEN 'consented' THEN 1 WHEN 'uploads-reconciled' THEN 2 WHEN 'complete' THEN 3 END
         AND (portal_intake.intake_attempt.work_item_ref IS NULL
              OR portal_intake.intake_attempt.work_item_ref=EXCLUDED.work_item_ref)
         AND (portal_intake.intake_attempt.state <> 'complete'
              OR (portal_intake.intake_attempt.attachment_receipts=EXCLUDED.attachment_receipts
                  AND portal_intake.intake_attempt.work_item_ref IS NOT DISTINCT FROM EXCLUDED.work_item_ref
                  AND portal_intake.intake_attempt.response_due_at IS NOT DISTINCT FROM EXCLUDED.response_due_at
                  AND portal_intake.intake_attempt.status IS NOT DISTINCT FROM EXCLUDED.status))`,
      [
        this.tenantId,
        attempt.attemptKey,
        attempt.inputHash,
        attempt.consentEventId,
        JSON.stringify(attempt.attachments),
        attempt.workItemRef ?? null,
        attempt.responseDueAt ?? null,
        attempt.status ?? null,
        attempt.state,
      ],
    );
    if (result.rowCount === 0)
      throw new IntakeError('attempt retry changed input or consent evidence');
  }
}

export interface IntakeWorkItemPort {
  open(input: {
    readonly tenantId: string;
    readonly intakeRef: string;
    readonly purpose: 'prospective-intake' | 'urgent-intake-review';
    readonly risk: 'routine' | 'urgent';
    readonly responseDueAt: string;
    readonly ownerRef: string;
    readonly poolRef: string;
    readonly occurredAt: string;
  }): Promise<{
    readonly workItemRef: string;
    readonly visibleStatus: 'submitted' | 'urgent-review';
    readonly responseDueAt: string;
  }>;
}

export class PracticeHubIdentityAdapter implements IntakeIdentityPort {
  public elevate(
    preAuth: PreAuthSession,
    basis: ElevationBasis,
  ):
    | { readonly kind: 'verified'; readonly link: ElevatedLink }
    | { readonly kind: 'withheld'; readonly humanPath: true; readonly secureChannelPath: true } {
    try {
      return { kind: 'verified', link: completeElevation(preAuth, basis) };
    } catch {
      const directive = declineOrFailElevation(preAuth);
      return {
        kind: 'withheld',
        humanPath: directive.humanPathOffered,
        secureChannelPath: directive.secureChannelPathOffered,
      };
    }
  }
}

export class PracticeHubDocumentAdapter implements IntakeUploadPort {
  private readonly logs = new Map<string, readonly DocumentEvent[]>();
  private readonly results = new Map<
    string,
    { readonly inputHash: string; readonly result: IntakeUploadResult }
  >();
  public constructor(
    private readonly store: BlobStore,
    private readonly inspect: (bytes: string) => readonly string[],
  ) {}

  public async receive(
    input: Parameters<IntakeUploadPort['receive']>[0],
  ): Promise<IntakeUploadResult> {
    const key = `${input.tenantId.length}:${input.tenantId}|${input.documentRef.length}:${input.documentRef}`;
    const inputHash = hashContent(JSON.stringify(input));
    const priorResult = this.results.get(key);
    if (priorResult !== undefined) {
      if (priorResult.inputHash !== inputHash)
        throw new IntakeError('document retry changed input');
      return priorResult.result;
    }
    const observedAttributeNames = this.inspect(input.bytes);
    const badName = observedAttributeNames.find(
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
    );
    if (badName !== undefined)
      throw new IntakeError(`observed attribute name is not allowed: ${badName}`);
    const prior = this.logs.get(key) ?? [];
    const received = receiveDocument(this.store, prior, {
      documentEventId: `${input.documentRef}-received`,
      tenantId: input.tenantId,
      documentId: input.documentRef,
      source: 'portal_upload',
      bytes: input.bytes,
      mediaType: input.mediaType,
      pageCount: input.pageCount,
      actorRef: input.actorRef,
      occurredAt: input.occurredAt,
      synthetic: true,
    });
    if (!verifyBlobIntegrity(this.store, received.blobRef, received.event.contentHash as string)) {
      throw new IntakeError('upload content-address integrity check failed');
    }
    const quarantined = appendDocumentEvent(received.log, {
      documentEventId: `${input.documentRef}-quarantined`,
      tenantId: input.tenantId,
      documentId: input.documentRef,
      eventType: 'quarantined',
      actorRef: input.actorRef,
      occurredAt: input.occurredAt,
      quarantineReason: 'unknown-patient',
      observedAttributeNames: observedAttributeNames as readonly (
        | 'patient-name'
        | 'date-of-birth'
        | 'address'
        | 'phone'
        | 'mrn'
        | 'ssn-last4'
        | 'member-id'
        | 'sender-fax'
        | 'account-number'
      )[],
      synthetic: true,
    });
    this.logs.set(key, quarantined.log);
    const result: IntakeUploadResult = {
      kind: 'quarantined',
      documentRef: input.documentRef,
      blobRef: received.blobRef,
      contentHash: received.event.contentHash as string,
      observedAttributeNames,
    };
    this.results.set(key, { inputHash, result });
    return result;
  }
}

export class PracticeHubWorkItemAdapter implements IntakeWorkItemPort {
  public constructor(private readonly exec: Queryable) {}

  public async open(input: Parameters<IntakeWorkItemPort['open']>[0]) {
    const fingerprint = JSON.stringify([
      input.tenantId,
      input.intakeRef,
      input.purpose,
      input.risk,
      input.responseDueAt,
      input.ownerRef,
      input.poolRef,
      input.occurredAt,
    ]);
    const workItemRef = `wi-portal-${hashContent(fingerprint).slice(0, 32)}`;
    const bySubject = await this.exec.query(
      `SELECT work_item_id FROM events.work_item WHERE origin='admin' AND subject_ref=$1`,
      [input.intakeRef],
    );
    const priorForSubject = bySubject.rows[0];
    if (priorForSubject !== undefined && String(priorForSubject['work_item_id']) !== workItemRef) {
      throw new IntakeError('WorkItem retry changed input');
    }
    const existing = await loadWorkItem(this.exec, workItemRef);
    if (existing !== null) {
      if (
        existing.subjectRef !== input.intakeRef ||
        existing.purpose !== input.purpose ||
        existing.risk !== input.risk ||
        existing.ownerRef !== input.ownerRef ||
        existing.responseDueAt !== input.responseDueAt
      )
        throw new IntakeError('WorkItem retry changed input');
      return {
        workItemRef,
        visibleStatus:
          input.risk === 'urgent' ? ('urgent-review' as const) : ('submitted' as const),
        responseDueAt: input.responseDueAt,
      };
    }
    const opened = await openWorkItem(this.exec, {
      tenantId: input.tenantId,
      open: {
        workItemId: workItemRef,
        origin: 'admin',
        subjectRef: input.intakeRef,
        purpose: input.purpose,
        risk: input.risk,
        serviceTier: 'prospect',
        slaPolicyId: null,
        policyVersion: null,
        responseDueAt: input.responseDueAt,
        poolId: input.poolRef,
        openedAt: input.occurredAt,
      },
      actorRef: 'synthetic-system:portal-intake',
    });
    const assigned = await appendEvents(this.exec, input.tenantId, workItemRef, [
      {
        workItemId: workItemRef,
        eventSeq: opened.lastEventSeq + 1,
        eventType: 'assigned',
        occurredAt: input.occurredAt,
        toOwnerRef: input.ownerRef,
        reason: 'assignment',
      },
    ]);
    if (assigned.ownerRef !== input.ownerRef) throw new IntakeError('WorkItem was not assigned');
    return {
      workItemRef,
      visibleStatus: input.risk === 'urgent' ? ('urgent-review' as const) : ('submitted' as const),
      responseDueAt: input.responseDueAt,
    };
  }
}

export type { AuthChallenge };
