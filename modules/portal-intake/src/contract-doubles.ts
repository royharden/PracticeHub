import type { CollectionConsentEvent, IntakeAttempt, IntakeRecord } from './intake-types.js';
import type {
  IntakeAttemptPort,
  IntakeRecordPort,
  IntakeUploadPort,
  IntakeUploadResult,
  IntakeWorkItemPort,
} from './ports.js';

export class RecordingUploadDouble implements IntakeUploadPort {
  public readonly calls: Array<Parameters<IntakeUploadPort['receive']>[0]> = [];
  public async receive(
    input: Parameters<IntakeUploadPort['receive']>[0],
  ): Promise<IntakeUploadResult> {
    this.calls.push(input);
    return {
      kind: 'quarantined',
      documentRef: input.documentRef,
      blobRef: `blob://documents/${'a'.repeat(64)}`,
      contentHash: 'a'.repeat(64),
      observedAttributeNames: ['patient-name'],
    };
  }
}

export class InMemoryIntakeAttemptStore implements IntakeAttemptPort {
  private readonly attempts = new Map<string, IntakeAttempt>();
  public async load(attemptKey: string): Promise<IntakeAttempt | null> {
    return this.attempts.get(attemptKey) ?? null;
  }
  public async save(attempt: IntakeAttempt): Promise<void> {
    const prior = this.attempts.get(attempt.attemptKey);
    const rank = { consented: 1, 'uploads-reconciled': 2, complete: 3 } as const;
    const priorReceiptsPreserved =
      prior === undefined ||
      prior.attachments.every((receipt) =>
        attempt.attachments.some(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(receipt),
        ),
      );
    const completedStable =
      prior === undefined ||
      prior.state !== 'complete' ||
      (JSON.stringify(prior.attachments) === JSON.stringify(attempt.attachments) &&
        prior.workItemRef === attempt.workItemRef &&
        prior.responseDueAt === attempt.responseDueAt &&
        prior.status === attempt.status);
    if (
      prior !== undefined &&
      (prior.inputHash !== attempt.inputHash ||
        prior.consentEventId !== attempt.consentEventId ||
        prior.attachments.length > attempt.attachments.length ||
        !priorReceiptsPreserved ||
        !completedStable ||
        rank[prior.state] > rank[attempt.state] ||
        (prior.workItemRef !== undefined && prior.workItemRef !== attempt.workItemRef))
    ) {
      throw new Error('attempt checkpoint regression or drift');
    }
    this.attempts.set(attempt.attemptKey, attempt);
  }
}

export class InMemoryIntakeRecordStore implements IntakeRecordPort {
  public readonly consentEvents: CollectionConsentEvent[] = [];
  public readonly submissions: IntakeRecord[] = [];

  public async appendCollectionConsent(event: CollectionConsentEvent): Promise<void> {
    const prior = this.consentEvents.find((entry) => entry.eventId === event.eventId);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(event)) {
      throw new Error('consent retry drift');
    }
    if (prior === undefined) this.consentEvents.push(event);
  }

  public async appendSubjectLink(event: CollectionConsentEvent): Promise<void> {
    await this.appendCollectionConsent(event);
  }

  public async saveSubmission(record: IntakeRecord): Promise<void> {
    const prior = this.submissions.findIndex(
      (entry) => entry.intakeRef === record.intakeRef && entry.tenantId === record.tenantId,
    );
    if (prior === -1) this.submissions.push(record);
    else this.submissions[prior] = record;
  }
}

export class RecordingWorkItemDouble implements IntakeWorkItemPort {
  public readonly calls: Array<Parameters<IntakeWorkItemPort['open']>[0]> = [];
  public async open(input: Parameters<IntakeWorkItemPort['open']>[0]) {
    this.calls.push(input);
    return {
      workItemRef: `wi-${input.intakeRef}`,
      visibleStatus: input.risk === 'urgent' ? ('urgent-review' as const) : ('submitted' as const),
      responseDueAt: input.responseDueAt,
    };
  }
}
