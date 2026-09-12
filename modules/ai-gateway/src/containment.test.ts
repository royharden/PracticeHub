import type { TenantId } from '@practicehub/contracts';
import { describe, expect, it } from 'vitest';

import { PostgresContainmentPort } from './containment.js';
import { RecordingContainment } from './recording-ports.js';

describe('PostgresContainmentPort', () => {
  it('uses the exact four-field blast-radius key and caller transaction', async () => {
    const calls: Array<{ text: string; params: readonly unknown[] }> = [];
    const exec = {
      async query(text: string, params: readonly unknown[] = []) {
        calls.push({ text, params });
        return { rows: [] };
      },
    };
    const port = new PostgresContainmentPort(exec);
    const record = {
      tenantId: 'northwind-synthetic' as TenantId,
      useCase: 'draft-summary',
      cohortRef: 'cohort-alpha',
      bindingRef: 'binding:alpha',
      incidentRef: 'incident:001',
      fallbackRef: 'fallback:human:summary',
      reason: 'model-version-drift',
      containedAt: '2026-06-01T09:00:00Z',
      synthetic: true as const,
    };
    await port.kill(record);
    await expect(port.current(record)).resolves.toBeNull();
    expect(calls[0]?.text).toContain('ON CONFLICT (tenant_id,use_case,cohort_ref,binding_ref)');
    expect(calls[1]?.params).toEqual([
      record.tenantId,
      record.useCase,
      record.cohortRef,
      record.bindingRef,
    ]);
  });
});

describe('exact cohort containment', () => {
  it('does not contain a sibling cohort sharing tenant, feature and binding', async () => {
    const port = new RecordingContainment();
    const base = {
      tenantId: 'northwind-synthetic' as TenantId,
      useCase: 'draft-summary',
      bindingRef: 'binding:summary',
      incidentRef: 'incident:001',
      fallbackRef: 'fallback:human:summary',
      reason: 'model-version-drift',
      containedAt: '2026-06-01T09:00:00Z',
      synthetic: true as const,
    };
    await port.kill({ ...base, cohortRef: 'cohort-alpha' });
    await expect(port.current({ ...base, cohortRef: 'cohort-alpha' })).resolves.toBeDefined();
    await expect(port.current({ ...base, cohortRef: 'cohort-beta' })).resolves.toBeNull();
  });
});
