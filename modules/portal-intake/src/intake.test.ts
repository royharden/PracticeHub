import { describe, expect, it } from 'vitest';

import {
  InMemoryIntakeAttemptStore,
  InMemoryIntakeRecordStore,
  RecordingUploadDouble,
  RecordingWorkItemDouble,
} from './contract-doubles.js';
import {
  appendCollectionConsentEvent,
  abandonIntake,
  collectionConsentEvidenceHash,
  linkCollectionConsentToPerson,
  submitIntake,
  type SubmitIntakeInput,
} from './intake.js';
import type { CollectionConsentEvent } from './intake-types.js';
import { syntheticPortalIntakeDefinition } from './seed-data.js';

const baseEvidence = {
  intakeRef: 'intake-synthetic-001',
  prospectRef: 'prospect-synthetic-001',
  decision: 'granted' as const,
  quizVersion: syntheticPortalIntakeDefinition.version,
  noticeVersion: 'privacy-v1',
  embeddingOrigin: 'https://intake.synthetic.test',
  occurredAt: '2026-09-12T10:00:00Z',
};

function consent(overrides: Partial<CollectionConsentEvent> = {}): CollectionConsentEvent {
  const evidence = { ...baseEvidence, ...overrides };
  return {
    eventId: 'collection-consent-001',
    tenantId: 'northwind-synthetic',
    ...evidence,
    purpose: 'quiz-collection',
    evidenceRef: 'evidence:collection-consent-001',
    evidenceHash: collectionConsentEvidenceHash(evidence),
    synthetic: true,
    ...overrides,
  };
}

function submission(overrides: Partial<SubmitIntakeInput> = {}): SubmitIntakeInput {
  return {
    tenantId: 'northwind-synthetic',
    intakeRef: baseEvidence.intakeRef,
    prospectRef: baseEvidence.prospectRef,
    definition: syntheticPortalIntakeDefinition,
    channel: 'primary-web',
    embeddingOrigin: baseEvidence.embeddingOrigin,
    explicitConsentControl: true,
    collectionConsent: consent(),
    fields: {
      'contact-email': 'prospect@example.test',
      'urgency-screen': 'routine',
      location: 'nv',
      'service-interest': 'primary-care',
    },
    healthAnswers: { 'health-goal': 'synthetic-improved-mobility' },
    responseDueAt: '2026-09-12T14:00:00Z',
    ownerRef: 'synthetic-guide:intake',
    occurredAt: baseEvidence.occurredAt,
    attemptKey: 'attempt-synthetic-001',
    synthetic: true,
    ...overrides,
  };
}

describe('collection consent evidence chain', () => {
  it('is a distinct append-only quiz-collection event and idempotently replays exact bytes', () => {
    const event = consent();
    const once = appendCollectionConsentEvent([], event);
    expect(appendCollectionConsentEvent(once, event)).toBe(once);
    expect(event.purpose).toBe('quiz-collection');
    expect(JSON.stringify(event)).not.toContain('treatment-consent');
    expect(JSON.stringify(event)).not.toContain('marketing-consent');
  });

  it('links a verified patient without changing the source evidence ref or hash', () => {
    const source = consent();
    const linked = linkCollectionConsentToPerson(
      [source],
      source.eventId,
      'collection-link-001',
      'person:synthetic-001',
      '2026-09-12T10:05:00Z',
    );
    expect(linked[1]).toMatchObject({
      governedPersonRef: 'person:synthetic-001',
      sourceEventId: source.eventId,
      evidenceRef: source.evidenceRef,
      evidenceHash: source.evidenceHash,
    });
  });

  it('rejects impossible calendar instants and a subject link before its source', () => {
    expect(() =>
      appendCollectionConsentEvent([], consent({ occurredAt: '2026-02-31T10:00:00Z' })),
    ).toThrow(/real UTC instant/);
    const source = consent();
    expect(() =>
      linkCollectionConsentToPerson(
        [source],
        source.eventId,
        'collection-link-early',
        'person:synthetic-001',
        '2026-09-12T09:59:59Z',
      ),
    ).toThrow(/cannot predate/);
    expect(() =>
      appendCollectionConsentEvent([source], {
        ...source,
        eventId: 'collection-link-cross-tenant',
        sourceEventId: source.eventId,
        governedPersonRef: 'person:synthetic-001',
        tenantId: 'riverbend-synthetic',
        occurredAt: '2026-09-12T10:01:00Z',
      }),
    ).toThrow(/preserve exact source/);
  });
});

describe('prospective intake submission', () => {
  it('clears optional health detail at the disclosed retention boundary', () => {
    const result = abandonIntake({
      tenantId: 'northwind-synthetic',
      definitionVersion: syntheticPortalIntakeDefinition.version,
      retainedUntil: '2026-09-12T11:00:00Z',
      at: '2026-09-12T11:00:00Z',
      optionalHealthBuffer: { 'health-goal': 'synthetic-sensitive-value' },
    });
    expect(result).toMatchObject({
      cleaned: true,
      optionalHealthBuffer: {},
      metric: { reason: 'retention-expired' },
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-value');
  });
  it('submits allowed fields, quarantines upload refs, and creates one owned task receipt', async () => {
    const workItems = new RecordingWorkItemDouble();
    const uploads = new RecordingUploadDouble();
    const result = await submitIntake(
      workItems,
      uploads,
      new InMemoryIntakeAttemptStore(),
      new InMemoryIntakeRecordStore(),
      submission({
        attachments: [
          {
            documentRef: 'portal-doc-synthetic-001',
            bytes: 'synthetic pdf',
            mediaType: 'application/pdf',
            pageCount: 1,
          },
        ],
      }),
    );
    expect(result.outcome).toBe('submitted');
    if (result.outcome !== 'submitted') return;
    expect(result.record).toMatchObject({
      status: 'submitted',
      workItemRef: 'wi-intake-synthetic-001',
      attachments: [{ documentRef: 'portal-doc-synthetic-001' }],
    });
    expect(workItems.calls).toHaveLength(1);
    expect(uploads.calls).toHaveLength(1);
  });

  it('decline persists only an anonymous metric and calls no health-bearing provider', async () => {
    const workItems = new RecordingWorkItemDouble();
    const uploads = new RecordingUploadDouble();
    const declinedBase = { ...baseEvidence, decision: 'declined' as const };
    const result = await submitIntake(
      workItems,
      uploads,
      new InMemoryIntakeAttemptStore(),
      new InMemoryIntakeRecordStore(),
      submission({
        explicitConsentControl: false,
        collectionConsent: consent({
          decision: 'declined',
          evidenceHash: collectionConsentEvidenceHash(declinedBase),
        }),
        healthAnswers: { secret: 'synthetic-sensitive-value' },
      }),
    );
    expect(result).toMatchObject({ outcome: 'declined', persistedHealthValues: [] });
    expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-value');
    expect(workItems.calls).toHaveLength(0);
    expect(uploads.calls).toHaveLength(0);
  });

  it('routes emergency intake only to clinical work and never a sales pool', async () => {
    const workItems = new RecordingWorkItemDouble();
    const result = await submitIntake(
      workItems,
      new RecordingUploadDouble(),
      new InMemoryIntakeAttemptStore(),
      new InMemoryIntakeRecordStore(),
      submission({
        fields: {
          'contact-email': 'urgent@example.test',
          'urgency-screen': 'emergency',
          location: 'nv',
        },
      }),
    );
    expect(result.outcome).toBe('submitted');
    expect(workItems.calls[0]).toMatchObject({
      purpose: 'urgent-intake-review',
      risk: 'urgent',
      poolRef: 'clinical-intake',
    });
    expect(JSON.stringify(workItems.calls)).not.toContain('sales');
  });

  it('rejects unlisted medical history before any provider effect', async () => {
    const workItems = new RecordingWorkItemDouble();
    await expect(
      submitIntake(
        workItems,
        new RecordingUploadDouble(),
        new InMemoryIntakeAttemptStore(),
        new InMemoryIntakeRecordStore(),
        submission({
          fields: {
            'contact-email': 'x@example.test',
            'urgency-screen': 'routine',
            location: 'nv',
            'medical-history': 'synthetic-sensitive-value',
          },
        }),
      ),
    ).rejects.toThrow(/unlisted pre-registration field/);
    expect(workItems.calls).toHaveLength(0);
  });

  it('applies the same consent gate to embedded intake', async () => {
    const input = submission({ channel: 'embedded-web', explicitConsentControl: false });
    await expect(
      submitIntake(
        new RecordingWorkItemDouble(),
        new RecordingUploadDouble(),
        new InMemoryIntakeAttemptStore(),
        new InMemoryIntakeRecordStore(),
        input,
      ),
    ).rejects.toThrow(/cannot bypass/);
  });

  it('rejects undeclared health keys before any provider effect', async () => {
    const workItems = new RecordingWorkItemDouble();
    await expect(
      submitIntake(
        workItems,
        new RecordingUploadDouble(),
        new InMemoryIntakeAttemptStore(),
        new InMemoryIntakeRecordStore(),
        submission({ healthAnswers: { 'undeclared-history': 'synthetic-sensitive-value' } }),
      ),
    ).rejects.toThrow(/undeclared health field/);
    expect(workItems.calls).toHaveLength(0);
  });

  it.each([
    ['impossible submission instant', { occurredAt: '2026-02-30T10:00:00Z' }, /real UTC instant/],
    ['submission before consent', { occurredAt: '2026-09-12T09:00:00Z' }, /cannot predate/],
    ['due before submission', { responseDueAt: '2026-09-12T09:00:00Z' }, /must follow/],
  ])('rejects %s before provider effects', async (_name, overrides, error) => {
    const workItems = new RecordingWorkItemDouble();
    await expect(
      submitIntake(
        workItems,
        new RecordingUploadDouble(),
        new InMemoryIntakeAttemptStore(),
        new InMemoryIntakeRecordStore(),
        submission(overrides),
      ),
    ).rejects.toThrow(error);
    expect(workItems.calls).toHaveLength(0);
  });

  it('reconciles an interrupted task open without uploading twice', async () => {
    const attempts = new InMemoryIntakeAttemptStore();
    const uploads = new RecordingUploadDouble();
    let fail = true;
    const workItems = new RecordingWorkItemDouble();
    const original = workItems.open.bind(workItems);
    workItems.open = async (input) => {
      if (fail) {
        fail = false;
        throw new Error('synthetic injected task outage');
      }
      return original(input);
    };
    const input = submission({
      attemptKey: 'attempt-recovery-001',
      attachments: [
        {
          documentRef: 'portal-doc-recovery-001',
          bytes: 'synthetic pdf',
          mediaType: 'application/pdf',
          pageCount: 1,
        },
      ],
    });
    const records = new InMemoryIntakeRecordStore();
    await expect(submitIntake(workItems, uploads, attempts, records, input)).rejects.toThrow(
      /task outage/,
    );
    expect(
      Object.keys((await attempts.load(input.attemptKey))?.attachments[0] ?? {}).sort(),
    ).toEqual(['blobRef', 'contentHash', 'documentRef', 'observedAttributeNames'].sort());
    await expect(submitIntake(workItems, uploads, attempts, records, input)).resolves.toMatchObject(
      {
        outcome: 'submitted',
      },
    );
    await expect(submitIntake(workItems, uploads, attempts, records, input)).resolves.toMatchObject(
      { outcome: 'submitted' },
    );
    expect(uploads.calls).toHaveLength(1);
    expect(workItems.calls).toHaveLength(1);
  });

  it('refuses a stale attempt checkpoint after completion', async () => {
    const attempts = new InMemoryIntakeAttemptStore();
    const complete = {
      attemptKey: 'attempt-monotonic-001',
      inputHash: 'a'.repeat(64),
      consentEventId: 'consent-monotonic-001',
      attachments: [],
      workItemRef: 'wi-monotonic-001',
      responseDueAt: '2026-09-12T14:00:00Z',
      status: 'submitted' as const,
      state: 'complete' as const,
      synthetic: true as const,
    };
    await attempts.save(complete);
    await expect(attempts.save({ ...complete, state: 'uploads-reconciled' })).rejects.toThrow(
      /regression or drift/,
    );
    await expect(
      attempts.save({ ...complete, responseDueAt: '2026-09-12T15:00:00Z' }),
    ).rejects.toThrow(/regression or drift/);
  });

  it('refuses same-length replacement of a previously recorded upload receipt', async () => {
    const attempts = new InMemoryIntakeAttemptStore();
    const base = {
      attemptKey: 'attempt-receipt-prefix-001',
      inputHash: 'b'.repeat(64),
      consentEventId: 'consent-receipt-prefix-001',
      attachments: [
        {
          documentRef: 'doc-a',
          blobRef: `blob://documents/${'a'.repeat(64)}`,
          contentHash: 'a'.repeat(64),
          observedAttributeNames: ['patient-name'],
        },
      ],
      state: 'uploads-reconciled' as const,
      synthetic: true as const,
    };
    await attempts.save(base);
    await expect(
      attempts.save({
        ...base,
        attachments: [
          {
            documentRef: 'doc-b',
            blobRef: `blob://documents/${'b'.repeat(64)}`,
            contentHash: 'b'.repeat(64),
            observedAttributeNames: ['patient-name'],
          },
        ],
      }),
    ).rejects.toThrow(/regression or drift/);
  });
});

export { consent as syntheticConsent, submission as syntheticSubmission };
