import {
  exportMediaType,
  exportSchemaId,
  PortabilityError,
  type Domain,
  type DomainCounts,
  type ExportEnvelope,
  type PortableRecord,
  type ReimportResult,
  type WorkingSet,
} from './types.js';

function emptyCounts(): DomainCounts {
  return {
    person: 0,
    encounter: 0,
    note: 0,
    document: 0,
    entitlement: 0,
    consent: 0,
    comms_thread: 0,
    audit_event: 0,
  };
}

function countRecords(records: readonly PortableRecord[]): DomainCounts {
  const counts = emptyCounts();
  const next: { [K in Domain]: number } = { ...counts };
  for (const record of records) {
    next[record.domain] += 1;
  }
  return next;
}

function cloneRecord(record: PortableRecord, recordId = record.recordId): PortableRecord {
  return {
    domain: record.domain,
    recordId,
    tenantId: record.tenantId,
    legalEntityId: record.legalEntityId,
    partitionTags: [...record.partitionTags],
    body: { ...record.body },
  };
}

function assertTagsSurvive(source: PortableRecord, exported: PortableRecord): void {
  const src = [...source.partitionTags].sort();
  const out = [...exported.partitionTags].sort();
  if (src.join(',') !== out.join(',')) {
    throw new PortabilityError(`partition tags dropped for ${source.recordId}`);
  }
}

export class SelfPortability {
  public constructor(private readonly store: WorkingSet) {}

  public standingExport(exportedAt: string): ExportEnvelope {
    return this.buildEnvelope(this.store.records, null, exportedAt);
  }

  public sliceByDomain(domain: Domain, exportedAt: string): ExportEnvelope {
    const records = this.store.records.filter((record) => record.domain === domain);
    return this.buildEnvelope(records, null, exportedAt);
  }

  public divestitureExport(legalEntityId: string, exportedAt: string): ExportEnvelope {
    const records = this.store.records.filter((record) => record.legalEntityId === legalEntityId);
    if (records.length === 0) {
      throw new PortabilityError(`no records for legal entity ${legalEntityId}`);
    }
    const envelope = this.buildEnvelope(records, legalEntityId, exportedAt);
    const leaked = envelope.records.filter((record) => record.legalEntityId !== legalEntityId);
    if (leaked.length > 0) {
      throw new PortabilityError('divestiture leak: other legal entity');
    }
    const sourceSensitive = records.filter((record) =>
      record.partitionTags.some((tag) => tag === 'gipa-genetic' || tag === 'part-2'),
    );
    for (const source of sourceSensitive) {
      const exported = envelope.records.find((record) => record.recordId === source.recordId);
      if (exported === undefined) {
        throw new PortabilityError(`divestiture dropped tagged record ${source.recordId}`);
      }
      assertTagsSurvive(source, exported);
    }
    const sourceCounts = countRecords(records);
    if (JSON.stringify(sourceCounts) !== JSON.stringify(envelope.counts)) {
      throw new PortabilityError('divestiture counts do not match source');
    }
    return envelope;
  }

  public reimport(envelope: ExportEnvelope): ReimportResult {
    if (envelope.mediaType !== exportMediaType) {
      throw new PortabilityError('unknown export media type');
    }
    if (envelope.schemaId !== exportSchemaId) {
      throw new PortabilityError('unknown export schema');
    }
    if (envelope.tenantId !== this.store.tenantId) {
      throw new PortabilityError('reimport blocked: tenant mismatch');
    }
    if (envelope.synthetic !== true) {
      throw new PortabilityError('reimport blocked: live envelope');
    }
    const identityMap: Record<string, string> = {};
    const records = envelope.records.map((record) => {
      if (record.body === undefined || Object.keys(record.body).length === 0) {
        throw new PortabilityError(`opaque body for ${record.recordId}`);
      }
      const nextId = `imp-${record.recordId}`;
      identityMap[record.recordId] = nextId;
      return cloneRecord(record, nextId);
    });
    const counts = countRecords(records);
    if (JSON.stringify(counts) !== JSON.stringify(envelope.counts)) {
      throw new PortabilityError('reimport counts do not match envelope');
    }
    return {
      tenantId: envelope.tenantId,
      legalEntityId: envelope.legalEntityId,
      identityMap,
      counts,
      records,
    };
  }

  public rehydrate(imported: ReimportResult): WorkingSet {
    if (imported.tenantId !== this.store.tenantId) {
      throw new PortabilityError('rehydrate blocked: tenant mismatch');
    }
    return { tenantId: imported.tenantId, records: imported.records };
  }

  private buildEnvelope(
    records: readonly PortableRecord[],
    legalEntityId: string | null,
    exportedAt: string,
  ): ExportEnvelope {
    const cloned = records.map((record) => cloneRecord(record));
    return {
      mediaType: exportMediaType,
      schemaId: exportSchemaId,
      tenantId: this.store.tenantId,
      legalEntityId,
      exportedAt,
      synthetic: true,
      counts: countRecords(cloned),
      records: cloned,
    };
  }
}
