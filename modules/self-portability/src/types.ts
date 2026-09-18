export const domains = [
  'person',
  'encounter',
  'note',
  'document',
  'entitlement',
  'consent',
  'comms_thread',
  'audit_event',
] as const;
export type Domain = (typeof domains)[number];

export const partitionTags = ['gipa-genetic', 'part-2', 'none'] as const;
export type PartitionTag = (typeof partitionTags)[number];

export const exportSchemaId = 'practicehub-export-v1' as const;
export const exportMediaType = 'application/json' as const;

/** Inspectable synthetic domain record. Not an opaque collector token. */
export interface PortableRecord {
  readonly domain: Domain;
  readonly recordId: string;
  readonly tenantId: string;
  readonly legalEntityId: string;
  readonly partitionTags: readonly PartitionTag[];
  readonly body: Readonly<Record<string, string>>;
}

export interface WorkingSet {
  readonly tenantId: string;
  readonly records: readonly PortableRecord[];
}

export type DomainCounts = { readonly [K in Domain]: number };

export interface ExportEnvelope {
  readonly mediaType: typeof exportMediaType;
  readonly schemaId: typeof exportSchemaId;
  readonly tenantId: string;
  readonly legalEntityId: string | null;
  readonly exportedAt: string;
  readonly synthetic: true;
  readonly counts: DomainCounts;
  readonly records: readonly PortableRecord[];
}

export interface ReimportResult {
  readonly tenantId: string;
  readonly legalEntityId: string | null;
  readonly identityMap: Readonly<Record<string, string>>;
  readonly counts: DomainCounts;
  readonly records: readonly PortableRecord[];
}

export class PortabilityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PortabilityError';
  }
}
