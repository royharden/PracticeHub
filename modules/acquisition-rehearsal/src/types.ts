export const REHEARSAL_PANEL_SIZE = 20;

export type RehearsalOutcome = 'ready-20-of-20' | 'failed-cutover' | 'post-freeze-restored';

export interface RehearsalSubject {
  readonly subjectRef: string;
  readonly synthetic: true;
}

export interface RehearsalPanel {
  readonly tenantId: string;
  readonly panelId: string;
  readonly subjects: readonly RehearsalSubject[];
  readonly synthetic: true;
}

export interface RehearsalRun {
  readonly tenantId: string;
  readonly runId: string;
  readonly panelId: string;
  readonly imported: number;
  readonly cutOver: number;
  readonly outcome: RehearsalOutcome;
  readonly frozen: boolean;
  readonly restored: boolean;
  readonly rekeyed: boolean;
  readonly workItemId: string | null;
  readonly synthetic: true;
}

export class RehearsalError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RehearsalError';
  }
}

export function requireSynthetic(synthetic: boolean): void {
  if (synthetic !== true) {
    throw new RehearsalError('acquisition rehearsal facts must be synthetic');
  }
}
