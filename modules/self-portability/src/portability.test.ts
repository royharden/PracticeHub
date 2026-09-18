import { describe, expect, it } from 'vitest';

import { SelfPortability } from './portability.js';
import {
  domains,
  exportSchemaId,
  PortabilityError,
  type PortableRecord,
  type WorkingSet,
} from './types.js';

function rec(
  domain: PortableRecord['domain'],
  recordId: string,
  legalEntityId: string,
  partitionTags: PortableRecord['partitionTags'],
  display: string,
): PortableRecord {
  return {
    domain,
    recordId,
    tenantId: 'northwind-synthetic',
    legalEntityId,
    partitionTags,
    body: { display, domain },
  };
}

function workingSet(): WorkingSet {
  return {
    tenantId: 'northwind-synthetic',
    records: [
      rec('person', 'person-a', 'entity-a', ['none'], 'A'),
      rec('encounter', 'enc-a', 'entity-a', ['none'], 'enc-A'),
      rec('note', 'note-a', 'entity-a', ['gipa-genetic'], 'note-A'),
      rec('document', 'doc-a', 'entity-a', ['part-2'], 'doc-A'),
      rec('entitlement', 'ent-a', 'entity-a', ['none'], 'ent-A'),
      rec('consent', 'con-a', 'entity-a', ['none'], 'con-A'),
      rec('comms_thread', 'thr-a', 'entity-a', ['none'], 'thr-A'),
      rec('audit_event', 'aud-a', 'entity-a', ['none'], 'aud-A'),
      rec('person', 'person-b', 'entity-b', ['none'], 'B'),
      rec('note', 'note-b', 'entity-b', ['gipa-genetic'], 'note-B'),
    ],
  };
}

describe('SelfPortability', () => {
  it('round-trips open JSON records with source/export/reimport counts', () => {
    const source = workingSet();
    const port = new SelfPortability(source);
    const envelope = port.standingExport('2026-09-18T00:00:00Z');
    expect(envelope.mediaType).toBe('application/json');
    expect(envelope.schemaId).toBe(exportSchemaId);
    expect(envelope.synthetic).toBe(true);
    expect(envelope.records.every((item) => item.body.display !== undefined)).toBe(true);
    const sourceCount = source.records.length;
    expect(envelope.records.length).toBe(sourceCount);
    const imported = port.reimport(envelope);
    expect(imported.records.length).toBe(sourceCount);
    expect(imported.counts.person).toBe(2);
    expect(imported.identityMap['person-a']).toBe('imp-person-a');
    const hydrated = port.rehydrate(imported);
    expect(hydrated.records.length).toBe(sourceCount);
    expect(hydrated.records.every((item) => item.recordId.startsWith('imp-'))).toBe(true);
  });

  it('divests one legal entity corpus and keeps GIPA and Part-2 tags', () => {
    const port = new SelfPortability(workingSet());
    const envelope = port.divestitureExport('entity-a', '2026-09-18T00:00:00Z');
    expect(envelope.legalEntityId).toBe('entity-a');
    expect(envelope.records.every((item) => item.legalEntityId === 'entity-a')).toBe(true);
    expect(envelope.records.some((item) => item.recordId === 'person-b')).toBe(false);
    const note = envelope.records.find((item) => item.recordId === 'note-a');
    const doc = envelope.records.find((item) => item.recordId === 'doc-a');
    expect(note?.partitionTags).toEqual(['gipa-genetic']);
    expect(doc?.partitionTags).toEqual(['part-2']);
    expect(envelope.records.map((item) => item.domain).sort()).toEqual([...domains].sort());
  });

  it('fails closed on tenant mismatch and empty inspectable body', () => {
    const port = new SelfPortability(workingSet());
    const envelope = port.standingExport('2026-09-18T00:00:00Z');
    expect(() => port.reimport({ ...envelope, tenantId: 'other-tenant' })).toThrow(
      /tenant mismatch/,
    );
    const opaque = {
      ...envelope,
      records: envelope.records.map((item, index) => (index === 0 ? { ...item, body: {} } : item)),
    };
    expect(() => port.reimport(opaque)).toThrow(PortabilityError);
  });
});
