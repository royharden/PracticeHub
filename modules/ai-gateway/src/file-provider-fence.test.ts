import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileProviderRequestFence } from './file-provider-fence.js';

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map(async (path) => rm(path, { recursive: true }))),
);

describe('FileProviderRequestFence', () => {
  it('durably permits exact replay and refuses payload drift', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'practicehub-ai-fence-'));
    directories.push(directory);
    const fence = new FileProviderRequestFence(directory);
    const claim = {
      tenantId: 'northwind-synthetic',
      outboundIdempotencyKey: `ai-${'a'.repeat(64)}`,
      promptHash: 'b'.repeat(64),
      interactionRef: 'interaction:001',
    };
    await expect(fence.claim(claim)).resolves.toBe('new');
    await expect(new FileProviderRequestFence(directory).claim(claim)).resolves.toBe('same');
    await expect(fence.claim({ ...claim, promptHash: 'c'.repeat(64) })).resolves.toBe('conflict');
  });
});
