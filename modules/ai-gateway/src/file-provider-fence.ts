import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256 } from './guards.js';
import type { ProviderRequestFence } from './provider.js';

interface FenceRecord {
  readonly tenantId: string;
  readonly outboundIdempotencyKey: string;
  readonly promptHash: string;
  readonly interactionRef: string;
  readonly synthetic: true;
}

/** Durable local payload-drift fence paired with the durable simulator ledger. */
export class FileProviderRequestFence implements ProviderRequestFence {
  public constructor(private readonly baseDirectory: string) {}

  public async claim(
    input: Parameters<ProviderRequestFence['claim']>[0],
  ): Promise<'new' | 'same' | 'conflict'> {
    const key = sha256(`${input.tenantId}\u0000${input.outboundIdempotencyKey}`);
    const path = join(this.baseDirectory, `${key}.json`);
    await mkdir(this.baseDirectory, { recursive: true });
    try {
      const existing = JSON.parse(await readFile(path, 'utf8')) as FenceRecord;
      return existing.tenantId === input.tenantId &&
        existing.outboundIdempotencyKey === input.outboundIdempotencyKey &&
        existing.interactionRef === input.interactionRef &&
        existing.promptHash === input.promptHash &&
        existing.synthetic === true
        ? ('same' as const)
        : ('conflict' as const);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, 'wx');
      await handle.writeFile(`${JSON.stringify({ ...input, synthetic: true })}\n`, 'utf8');
      await handle.sync();
      return 'new' as const;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return this.claim(input);
      throw error;
    } finally {
      await handle?.close();
    }
  }
}
