import type { CapabilityGrantSnapshot, DryRunReport, WorkbenchContext } from './types.js';
import { reconcileControlTotals } from './reconciliation.js';

const stateRank: Readonly<Record<CapabilityGrantSnapshot['state'], number>> = {
  disabled: 0,
  scaffolded: 1,
  simulated: 2,
  shadow: 3,
  pilot: 4,
  active: 5,
  'read-only': -1,
  retiring: -1,
};

export interface WaveImportPreflight {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

export function evaluateWaveImportPreflight(
  context: WorkbenchContext,
  completedDryRun: Pick<
    DryRunReport,
    'tenantId' | 'waveRef' | 'readiness' | 'targetDataWrites' | 'controlTotals'
  > | null,
  targetCapabilityIds: readonly string[],
  grants: readonly CapabilityGrantSnapshot[],
): WaveImportPreflight {
  const reasons: string[] = [];
  const capabilityPattern = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
  if (
    completedDryRun === null ||
    completedDryRun.tenantId !== context.tenantId ||
    completedDryRun.waveRef !== context.waveRef ||
    completedDryRun.readiness !== 'ready-for-review' ||
    completedDryRun.targetDataWrites !== 0 ||
    completedDryRun.controlTotals.length === 0 ||
    completedDryRun.controlTotals.some((total) => total.state === 'blocking')
  ) {
    reasons.push('completed-reconciliation-required');
  }
  if (targetCapabilityIds.length === 0) {
    reasons.push('target-capability-required');
  }
  if (targetCapabilityIds.some((capabilityId) => !capabilityPattern.test(capabilityId))) {
    reasons.push('invalid-target-capability');
  }
  const grantKeys = grants.map(
    (grant) => `${grant.tenantId}|${grant.capabilityId}|${grant.waveRef ?? '(root)'}`,
  );
  if (new Set(grantKeys).size !== grantKeys.length) {
    reasons.push('duplicate-capability-grant');
  }
  if (
    grants.some(
      (grant) =>
        !capabilityPattern.test(grant.capabilityId) ||
        !Object.prototype.hasOwnProperty.call(stateRank, grant.state),
    )
  ) {
    reasons.push('invalid-capability-grant');
  }
  if (
    completedDryRun !== null &&
    completedDryRun.controlTotals.some(
      (total) =>
        total.source.tenantId !== context.tenantId || total.target.tenantId !== context.tenantId,
    )
  ) {
    reasons.push('cross-tenant-reconciliation');
  }
  if (
    completedDryRun !== null &&
    completedDryRun.controlTotals.some(
      (total) => !['reconciled', 'explained-difference', 'blocking'].includes(total.state),
    )
  ) {
    reasons.push('invalid-reconciliation-state');
  }
  if (completedDryRun !== null) {
    try {
      const explanations = Object.fromEntries(
        completedDryRun.controlTotals.flatMap((total) =>
          total.explanationRef === undefined
            ? []
            : [
                [
                  `${total.name}|${total.source.unit}|${total.source.currency ?? ''}`,
                  total.explanationRef,
                ],
              ],
        ),
      );
      const recomputed = reconcileControlTotals(
        context.tenantId,
        completedDryRun.controlTotals.map((total) => total.source),
        completedDryRun.controlTotals.map((total) => total.target),
        explanations,
      );
      if (
        recomputed.length !== completedDryRun.controlTotals.length ||
        recomputed.some(
          (total, index) => total.state !== completedDryRun.controlTotals[index]?.state,
        )
      ) {
        reasons.push('invalid-reconciliation-state');
      }
    } catch {
      reasons.push('invalid-reconciliation-state');
    }
  }
  const capabilityScopes = new Map<string, Set<string>>();
  for (const grant of grants) {
    const key = `${grant.tenantId}|${grant.capabilityId}`;
    const scopes = capabilityScopes.get(key) ?? new Set<string>();
    scopes.add(grant.waveRef ?? '(root)');
    capabilityScopes.set(key, scopes);
  }
  if ([...capabilityScopes.values()].some((scopes) => scopes.size > 1)) {
    reasons.push('ambiguous-capability-scope');
  }
  const find = (capabilityId: string): CapabilityGrantSnapshot | undefined =>
    grants.find(
      (grant) =>
        grant.tenantId === context.tenantId &&
        grant.capabilityId === capabilityId &&
        (grant.waveRef === undefined || grant.waveRef === context.waveRef),
    );
  const workbench = find('migration.workbench');
  if (workbench === undefined || stateRank[workbench.state] < stateRank.simulated) {
    reasons.push('workbench-below-simulated');
  }
  const waveImport = find('migration.wave-import');
  if (
    waveImport === undefined ||
    waveImport.waveRef !== context.waveRef ||
    stateRank[waveImport.state] < stateRank.simulated
  ) {
    reasons.push('wave-import-below-simulated');
  }
  for (const targetCapabilityId of [...new Set(targetCapabilityIds)].sort()) {
    const target = find(targetCapabilityId);
    if (target === undefined || stateRank[target.state] < stateRank.scaffolded) {
      reasons.push(`target-below-scaffolded:${targetCapabilityId}`);
    }
  }
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] };
}
