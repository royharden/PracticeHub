import {
  InMemoryIntakeAttemptStore,
  InMemoryIntakeRecordStore,
  RecordingUploadDouble,
  RecordingWorkItemDouble,
} from './contract-doubles.js';
import { abandonIntake, collectionConsentEvidenceHash, submitIntake } from './intake.js';
import { syntheticPortalIntakeDefinition } from './seed-data.js';

export const fixtureOps = [
  'submit',
  'decline',
  'reject-field',
  'reject-embed',
  'urgent',
  'abandon',
] as const;
export type FixtureOp = (typeof fixtureOps)[number];

export interface IntakeFixtureCase {
  readonly name: string;
  readonly op: FixtureOp;
  readonly expectOutcome?: 'submitted' | 'declined';
  readonly expectStatus?: 'submitted' | 'urgent-review';
  readonly expectError?: string;
  readonly expectNoHealthValue?: string;
}

export async function runIntakeFixtureCase(input: IntakeFixtureCase): Promise<void> {
  if (input.op === 'abandon') {
    const sensitive = input.expectNoHealthValue ?? 'synthetic-abandoned-health';
    const result = abandonIntake({
      tenantId: 'northwind-synthetic',
      definitionVersion: syntheticPortalIntakeDefinition.version,
      retainedUntil: '2026-09-12T11:00:00Z',
      at: '2026-09-12T11:00:00Z',
      optionalHealthBuffer: { 'health-goal': sensitive },
    });
    if (!result.cleaned || JSON.stringify(result).includes(sensitive))
      throw new Error('retention cleanup failed');
    return;
  }
  const workItems = new RecordingWorkItemDouble();
  const uploads = new RecordingUploadDouble();
  const declined = input.op === 'decline';
  const evidence = {
    intakeRef: 'intake-fixture-001',
    prospectRef: 'prospect-fixture-001',
    decision: declined ? ('declined' as const) : ('granted' as const),
    quizVersion: syntheticPortalIntakeDefinition.version,
    noticeVersion: 'privacy-v1',
    embeddingOrigin: 'https://fixture.synthetic.test',
    occurredAt: '2026-09-12T10:00:00Z',
  };
  const promise = submitIntake(
    workItems,
    uploads,
    new InMemoryIntakeAttemptStore(),
    new InMemoryIntakeRecordStore(),
    {
      tenantId: 'northwind-synthetic',
      intakeRef: evidence.intakeRef,
      prospectRef: evidence.prospectRef,
      definition: syntheticPortalIntakeDefinition,
      channel: input.op === 'reject-embed' ? 'embedded-web' : 'primary-web',
      embeddingOrigin: evidence.embeddingOrigin,
      explicitConsentControl: input.op !== 'decline' && input.op !== 'reject-embed',
      collectionConsent: {
        eventId: 'consent-fixture-001',
        tenantId: 'northwind-synthetic',
        ...evidence,
        purpose: 'quiz-collection',
        evidenceRef: 'evidence:fixture-consent',
        evidenceHash: collectionConsentEvidenceHash(evidence),
        synthetic: true,
      },
      fields:
        input.op === 'reject-field'
          ? {
              'contact-email': 'fixture@example.test',
              'urgency-screen': 'routine',
              location: 'nv',
              'medical-history': 'synthetic-secret',
            }
          : {
              'contact-email': 'fixture@example.test',
              'urgency-screen': input.op === 'urgent' ? 'emergency' : 'routine',
              location: 'nv',
            },
      healthAnswers: { 'health-goal': input.expectNoHealthValue ?? 'synthetic-health-answer' },
      responseDueAt: '2026-09-12T14:00:00Z',
      ownerRef: 'synthetic-guide:intake',
      attemptKey: 'attempt-fixture-001',
      occurredAt: evidence.occurredAt,
      synthetic: true,
    },
  );
  if (input.expectError !== undefined) {
    let message = '';
    try {
      await promise;
    } catch (error) {
      message = String(error);
    }
    if (!message.includes(input.expectError))
      throw new Error(`expected ${input.expectError}; got ${message}`);
    if (workItems.calls.length !== 0 || uploads.calls.length !== 0)
      throw new Error('refusal reached a provider');
    return;
  }
  const result = await promise;
  if (result.outcome !== input.expectOutcome)
    throw new Error(`expected ${input.expectOutcome}; got ${result.outcome}`);
  if (
    input.expectNoHealthValue !== undefined &&
    JSON.stringify(result).includes(input.expectNoHealthValue)
  ) {
    throw new Error('declined health value crossed the persistence result');
  }
  if (
    result.outcome === 'submitted' &&
    input.expectStatus !== undefined &&
    result.record.status !== input.expectStatus
  ) {
    throw new Error(`expected status ${input.expectStatus}; got ${result.record.status}`);
  }
}
