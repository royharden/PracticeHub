import type {
  BreachNotificationPortV1,
  NoticePrepareInputV1,
  NoticeReconcileInputV1,
  NoticeSendInputV1,
} from '../ports.js';

export type RecordingNoticeOutcome = {
  readonly state: 'accepted' | 'unknown' | 'delivered' | 'failed';
  readonly terminalEvidenceRef: string | null;
};

export class RecordingBreachNotificationPortV1 implements BreachNotificationPortV1 {
  public readonly version = 'v1' as const;
  public readonly prepared: NoticePrepareInputV1[] = [];
  public readonly sent: NoticeSendInputV1[] = [];
  public readonly reconciled: NoticeReconcileInputV1[] = [];

  public constructor(
    private readonly sendOutcome: RecordingNoticeOutcome,
    private readonly reconcileOutcome: {
      readonly state: 'delivered' | 'failed' | 'unknown';
      readonly terminalEvidenceRef: string | null;
    } = { state: 'unknown', terminalEvidenceRef: null },
  ) {}

  public async prepare(
    input: NoticePrepareInputV1,
  ): Promise<{ readonly noticeId: string; readonly payloadRef: string }> {
    this.prepared.push(input);
    return {
      noticeId: `notice-${input.idempotencyKey}`,
      payloadRef: `notice-payload:${input.idempotencyKey}`,
    };
  }

  public async sendApproved(
    input: NoticeSendInputV1,
  ): Promise<RecordingNoticeOutcome & { readonly effectKey: string }> {
    this.sent.push(input);
    return { ...this.sendOutcome, effectKey: `notice-effect:${input.idempotencyKey}` };
  }

  public async reconcile(input: NoticeReconcileInputV1): Promise<{
    readonly state: 'delivered' | 'failed' | 'unknown';
    readonly terminalEvidenceRef: string | null;
  }> {
    this.reconciled.push(input);
    return this.reconcileOutcome;
  }
}
