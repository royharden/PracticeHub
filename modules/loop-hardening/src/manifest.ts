export const loopIds = ['4A-comms-v1', '4B-paid-service-v1', '4C-clinical-v1-double'] as const;
export type LoopId = (typeof loopIds)[number];

export const primitiveIds = ['X-02', 'X-03', 'X-04', 'X-07'] as const;
export type PrimitiveId = (typeof primitiveIds)[number];

export const killPoints = [
  'before-effect',
  'after-effect-before-receipt',
  'after-receipt',
] as const;
export type KillPoint = (typeof killPoints)[number];

export interface ExecutionSpec {
  readonly executionId: string;
  readonly loopId: LoopId;
  readonly primitiveId: PrimitiveId;
  readonly killPoint?: KillPoint;
}

export const loopManifest = {
  '4A-comms-v1': {
    railId: 'RAIL-003',
    authorityId: 'AUTH-001',
    operation: 'send-message',
    provider: 'canonical-wp-030',
  },
  '4B-paid-service-v1': {
    railId: 'RAIL-008',
    authorityId: 'AUTH-006',
    operation: 'create-payment-intent',
    provider: 'canonical-wp-031',
  },
  '4C-clinical-v1-double': {
    railId: 'RAIL-002',
    authorityId: 'AUTH-007',
    operation: 'read-clinical-summary',
    provider: 'versioned-double-parity-pending',
  },
} as const;

export const invariantManifest = {
  'I-A': 'outcome-evidence-or-owned-timed-exception',
  'I-B': 'at-most-one-external-effect-and-product-transition',
  'I-C': 'comms-consent-negative;paid-and-clinical-not-applicable',
  'I-D': 'synthetic-ref-only-and-provider-egress-proof-forwarded',
  'I-E': 'one-bounded-recovery-then-owned-exception',
  'I-F': 'effect-receipt-or-exception-evidence-recorded',
  'I-G': 'unknown-never-reported-terminal',
  'I-H': 'three-kill-point-state-machine',
  'I-I': 'rail-heartbeat-alarm-observed;consumer-monitor-owner-forwarded',
} as const;

const executions: ExecutionSpec[] = [];
for (const loopId of loopIds) {
  for (const primitiveId of primitiveIds) {
    if (primitiveId === 'X-02') {
      for (const killPoint of killPoints) {
        executions.push({
          executionId: `${loopId}:${primitiveId}:${killPoint}`,
          loopId,
          primitiveId,
          killPoint,
        });
      }
    } else {
      executions.push({ executionId: `${loopId}:${primitiveId}`, loopId, primitiveId });
    }
  }
}

export const executionManifest: readonly ExecutionSpec[] = Object.freeze(executions);

export function requireExecution(executionId: string): ExecutionSpec {
  const execution = executionManifest.find((candidate) => candidate.executionId === executionId);
  if (execution === undefined) throw new Error(`UNKNOWN_WP033_EXECUTION:${executionId}`);
  return execution;
}
