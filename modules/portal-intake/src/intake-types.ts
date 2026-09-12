export const preRegistrationFieldKeys = [
  'contact-email',
  'contact-phone',
  'routing-preference',
  'urgency-screen',
  'location',
  'service-interest',
  'accommodation',
] as const;
export type PreRegistrationFieldKey = (typeof preRegistrationFieldKeys)[number];

export type IntakeChannel = 'primary-web' | 'embedded-web' | 'staff-assisted';
export type IntakeStatus = 'draft' | 'submitted' | 'urgent-review' | 'abandoned';

export interface IntakeDefinitionField {
  readonly key: PreRegistrationFieldKey;
  readonly required: boolean;
  readonly purpose: string;
  readonly sensitivity: 'contact' | 'routing' | 'health';
  readonly respondentRole: 'prospect' | 'patient' | 'proxy';
  readonly visibilitySegment: 'intake' | 'clinical';
  readonly retentionRule: string;
}

export interface IntakeDefinition {
  readonly definitionId: string;
  readonly version: string;
  readonly effectiveAt: string;
  readonly privacyNoticeRef: string;
  readonly communicationChoiceRequired: true;
  readonly fields: readonly IntakeDefinitionField[];
  readonly healthFields: readonly {
    readonly key: string;
    readonly purpose: string;
    readonly sensitivity: 'health';
    readonly collectionConsentPurpose: 'quiz-collection';
    readonly retentionRule: string;
  }[];
  readonly synthetic: true;
}

export interface CollectionConsentEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly intakeRef: string;
  readonly prospectRef: string;
  readonly decision: 'granted' | 'declined';
  readonly purpose: 'quiz-collection';
  readonly quizVersion: string;
  readonly noticeVersion: string;
  readonly embeddingOrigin: string;
  readonly evidenceRef: string;
  readonly evidenceHash: string;
  readonly occurredAt: string;
  readonly governedPersonRef?: string;
  readonly sourceEventId?: string;
  readonly synthetic: true;
}

export interface IntakeRecord {
  readonly tenantId: string;
  readonly intakeRef: string;
  readonly prospectRef: string;
  readonly governedPersonRef?: string;
  readonly definitionVersion: string;
  readonly channel: IntakeChannel;
  readonly fields: Readonly<Partial<Record<PreRegistrationFieldKey, string>>>;
  readonly healthAnswers: Readonly<Record<string, string>>;
  readonly collectionConsentEventId: string;
  readonly collectionConsentEvidenceRef: string;
  readonly collectionConsentEvidenceHash: string;
  readonly workItemRef: string;
  readonly responseDueAt: string;
  readonly submittedAt: string;
  readonly status: 'submitted' | 'urgent-review';
  readonly attachments: readonly IntakeAttachmentReceipt[];
  readonly synthetic: true;
}

export interface IntakeAttachmentReceipt {
  readonly documentRef: string;
  readonly blobRef: string;
  readonly contentHash: string;
  readonly observedAttributeNames: readonly string[];
}

export interface AnonymousAbandonmentMetric {
  readonly tenantId: string;
  readonly definitionVersion: string;
  readonly reason: 'collection-consent-declined' | 'retention-expired';
  readonly occurredAt: string;
  readonly synthetic: true;
}

export interface IntakeAttempt {
  readonly attemptKey: string;
  readonly inputHash: string;
  readonly consentEventId: string;
  readonly attachments: readonly IntakeAttachmentReceipt[];
  readonly workItemRef?: string;
  readonly responseDueAt?: string;
  readonly status?: 'submitted' | 'urgent-review';
  readonly state: 'consented' | 'uploads-reconciled' | 'complete';
  readonly synthetic: true;
}

export class IntakeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IntakeError';
  }
}
