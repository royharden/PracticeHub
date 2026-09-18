export const EXIT_IDENTITY = 'WP-116/HUBSPOT-EXIT';

export const objectKinds = ['objects', 'owners', 'sequences', 'notes'] as const;
export type ObjectKind = (typeof objectKinds)[number];

export const phiGradeFields = ['email', 'phone', 'recordId'] as const;

export class HubspotExitError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HubspotExitError';
  }
}

export interface ExitRecord {
  readonly kind: ObjectKind;
  readonly recordId: string;
  readonly email: string;
  readonly phone: string;
  readonly synthetic: true;
}

export interface ExportManifest {
  readonly identity: typeof EXIT_IDENTITY;
  readonly windowHours: 24 | 30;
  readonly records: readonly ExitRecord[];
  readonly synthetic: true;
}

export interface CompletenessReport {
  readonly counts: Readonly<Record<ObjectKind, number>>;
  readonly missingPhi: readonly string[];
  readonly complete: boolean;
}

export interface ImportAck {
  readonly sentOnce: boolean;
  readonly reconciled: boolean;
  readonly importedIds: readonly string[];
}
