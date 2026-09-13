export interface BatchRecordLineage {
  readonly tenantId: string;
  readonly recordRef: string;
  readonly sourceRecordRef: string;
  readonly batchRef: string;
  readonly batchChanged: boolean;
  readonly userTouchedAfterBatch: boolean;
  readonly lastAuthoritativeEventRef: string;
}

export interface RollbackRecordDecision {
  readonly recordRef: string;
  readonly action: 'compensate' | 'manual-reconciliation-hold' | 'unchanged';
  readonly reason: string;
}

export function planBatchRollback(
  tenantId: string,
  batchRef: string,
  lineage: readonly BatchRecordLineage[],
): readonly RollbackRecordDecision[] {
  return lineage.map((record) => {
    if (record.tenantId !== tenantId || record.batchRef !== batchRef) {
      throw new Error('rollback lineage crossed tenant or batch scope');
    }
    if (!record.batchChanged) {
      return { recordRef: record.recordRef, action: 'unchanged', reason: 'batch-made-no-change' };
    }
    if (record.userTouchedAfterBatch) {
      return {
        recordRef: record.recordRef,
        action: 'manual-reconciliation-hold',
        reason: 'post-batch-user-activity-cannot-be-blindly-overwritten',
      };
    }
    return {
      recordRef: record.recordRef,
      action: 'compensate',
      reason: `reverse-from-event:${record.lastAuthoritativeEventRef}`,
    };
  });
}
