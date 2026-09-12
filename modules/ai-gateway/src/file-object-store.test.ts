import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { TenantId } from '@practicehub/contracts';

import { FileObjectStore } from './file-object-store.js';

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map(async (path) => rm(path, { recursive: true }))),
);

describe('FileObjectStore', () => {
  it('durably round-trips only through the exact tenant/subject/hash scope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'practicehub-ai-'));
    directories.push(directory);
    const store = new FileObjectStore(directory);
    const stored = await store.put({
      tenantId: 'northwind-synthetic' as TenantId,
      subjectRef: 'subject:northwind:001',
      originRef: 'gateway:prompt',
      body: 'synthetic body',
      synthetic: true,
    });
    expect(await store.get(stored)).toEqual(stored);
    expect(
      await store.put({
        tenantId: stored.tenantId,
        subjectRef: stored.subjectRef,
        originRef: stored.originRef,
        body: stored.body,
        synthetic: true,
      }),
    ).toEqual(stored);
    await expect(store.get({ ...stored, subjectRef: 'subject:northwind:002' })).rejects.toThrow();
    const disk = await readFile(
      join(directory, `${stored.bodyRef.slice('object:ai:'.length)}.json`),
      'utf8',
    );
    expect(disk).toContain('synthetic body');
  });
});
