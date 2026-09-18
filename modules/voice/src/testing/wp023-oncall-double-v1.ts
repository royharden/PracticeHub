import type { OnCallContextDouble } from '../ports.js';

export function wp023OnCallDoubleV1(): OnCallContextDouble {
  return {
    doubleId: 'wp023-oncall-double/v1',
    page(input) {
      return {
        contextPackageRef: `ctx:oncall:${input.tenantId}:${input.callId}`,
        workItemId: `wi:page:${input.callId}`,
      };
    },
  };
}
