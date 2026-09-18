export const RUNBOOK_IDENTITY = 'WP-118/DAY-ONE-BOOTSTRAP';

export const requiredSurfaces = [
  'staff',
  'hours',
  'locations',
  'templates',
  'printers',
  'fax',
  'intake',
] as const;

export type DayOneSurface = (typeof requiredSurfaces)[number];

export class DayOneError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DayOneError';
  }
}

export interface SurfaceRecord {
  readonly surface: DayOneSurface;
  readonly ready: boolean;
  readonly synthetic: true;
}

export interface RunbookResult {
  readonly identity: typeof RUNBOOK_IDENTITY;
  readonly present: readonly DayOneSurface[];
  readonly missing: readonly DayOneSurface[];
  readonly complete: boolean;
}
