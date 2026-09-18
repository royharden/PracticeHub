import { rehydrateInto, roundTrip } from '@practicehub/clinical-contracts';
import { describe, expect, it } from 'vitest';

import { MedplumLocalAdapter } from './adapter.js';
import { normalizeDeviceObservation } from './device.js';
import { MemoryClinicalStore } from './store.js';

describe('medplum-local adapter', () => {
  it('round-trips a PracticeHub observation without leaking Medplum types', async () => {
    const adapter = new MedplumLocalAdapter();
    const resource = {
      resourceType: 'Observation' as const,
      id: 'obs-1',
      tenantId: 'northwind-synthetic',
      subjectRef: 'wp060-subject-1',
      sourceVersion: 'clinical-record-port-v1-double',
      coding: { system: 'http://loinc.org', code: '8867-4' },
      synthetic: true as const,
    };
    const written = await adapter.persist(resource);
    const again = await roundTrip(adapter.store, written);
    expect(again.id).toBe('obs-1');
    expect(adapter.wp032.observation()?.parityStatus).toBe('WP-032-integration-required');
    const envelope = adapter.store.toMedplumEnvelope(written);
    expect(envelope.resourceType.startsWith('Medplum')).toBe(true);
  });

  it('normalizes a synthetic device observation onto LOINC', () => {
    const observation = normalizeDeviceObservation({
      tenantId: 'northwind-synthetic',
      subjectRef: 'wp060-subject-1',
      loinc: '8867-4',
      value: '72',
    });
    expect(observation.resourceType).toBe('Observation');
    expect(observation.coding.system).toBe('http://loinc.org');
  });

  it('rehydrates the corpus into a vanilla store', async () => {
    const source = new MemoryClinicalStore();
    const vanilla = new MemoryClinicalStore();
    await source.put({
      resourceType: 'Encounter',
      id: 'enc-1',
      tenantId: 'northwind-synthetic',
      subjectRef: 'wp060-subject-1',
      sourceVersion: 'clinical-record-port-v1-double',
      coding: { system: 'http://snomed.info/sct', code: '308335008' },
      synthetic: true,
    });
    const count = await rehydrateInto(source, vanilla);
    expect(count).toBe(1);
    expect((await vanilla.get('enc-1'))?.resourceType).toBe('Encounter');
  });
});
