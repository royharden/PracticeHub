import { EhiIngestError, emptyKindCounts } from './shapes.js';
import type { EhiResourceKind, EhiStagingPurgeReceipt, EhiStagingRow } from './types.js';

const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;

function rowKey(tenantId: string, waveRef: string, kind: EhiResourceKind, ref: string): string {
  return `${tenantId}|${waveRef}|${kind}|${ref}`;
}

/**
 * Tenant- and wave-scoped EHI staging tables. In-process placeholder for the
 * durable `migration` staging tables (FWD-MIG-068-STAGING-SQL): no target-domain
 * table is ever written from here.
 */
export class EhiStagingStore {
  readonly #rows = new Map<string, EhiStagingRow>();

  public put(row: EhiStagingRow): void {
    if (row.synthetic !== true) {
      throw new EhiIngestError('staging rows must carry the synthetic watermark');
    }
    this.#rows.set(rowKey(row.tenantId, row.waveRef, row.kind, row.sourceRecordRef), row);
  }

  public get(
    tenantId: string,
    waveRef: string,
    kind: EhiResourceKind,
    sourceRecordRef: string,
  ): EhiStagingRow | undefined {
    return this.#rows.get(rowKey(tenantId, waveRef, kind, sourceRecordRef));
  }

  public delete(tenantId: string, waveRef: string, kind: EhiResourceKind, ref: string): boolean {
    return this.#rows.delete(rowKey(tenantId, waveRef, kind, ref));
  }

  public rows(tenantId: string, waveRef: string): readonly EhiStagingRow[] {
    return [...this.#rows.values()]
      .filter((row) => row.tenantId === tenantId && row.waveRef === waveRef)
      .sort((a, b) => {
        const left = `${a.kind}|${a.sourceRecordRef}`;
        const right = `${b.kind}|${b.sourceRecordRef}`;
        return left < right ? -1 : left > right ? 1 : 0;
      });
  }

  public count(tenantId: string, waveRef: string): number {
    return this.rows(tenantId, waveRef).length;
  }

  /** All rows across every tenant; used only to prove purge scoping. */
  public totalRowCount(): number {
    return this.#rows.size;
  }
}

/**
 * Purges one tenant's wave from staging. Other tenants and other waves are
 * untouched. Idempotent: a second purge reports zero rows. Fails closed if any
 * row of the scope survives.
 */
export function purgeEhiStaging(
  staging: EhiStagingStore,
  scope: { readonly tenantId: string; readonly waveRef: string; readonly reasonRef: string },
): EhiStagingPurgeReceipt {
  for (const [field, value] of Object.entries(scope)) {
    if (!refPattern.test(value)) {
      throw new EhiIngestError(`purge ${field} must be a constrained reference`);
    }
  }
  const purgedByKind = emptyKindCounts();
  for (const row of staging.rows(scope.tenantId, scope.waveRef)) {
    if (staging.delete(row.tenantId, row.waveRef, row.kind, row.sourceRecordRef)) {
      purgedByKind[row.kind] += 1;
    }
  }
  if (staging.count(scope.tenantId, scope.waveRef) !== 0) {
    throw new EhiIngestError('staging purge left rows behind');
  }
  return {
    tenantId: scope.tenantId,
    waveRef: scope.waveRef,
    reasonRef: scope.reasonRef,
    purgedByKind,
    purgedRowCount: Object.values(purgedByKind).reduce((sum, value) => sum + value, 0),
    remainingRowCount: 0,
    synthetic: true,
  };
}
