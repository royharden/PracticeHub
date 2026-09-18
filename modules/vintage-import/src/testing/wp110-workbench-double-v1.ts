import { createHash } from 'node:crypto';

import type { WorkbenchSnapshotDouble } from '../types.js';

/** Local WP-110 import-workbench double. Does not import modules/migration. */
export class Wp110WorkbenchDoubleV1 implements WorkbenchSnapshotDouble {
  readonly #frozen = new Map<string, string>();

  public freeze(input: { readonly tenantId: string; readonly bytes: Uint8Array }): string {
    const digest = createHash('sha256').update(input.bytes).digest('hex');
    this.#frozen.set(JSON.stringify([input.tenantId, digest]), digest);
    return digest;
  }

  public has(tenantId: string, digest: string): boolean {
    return this.#frozen.has(JSON.stringify([tenantId, digest]));
  }
}
