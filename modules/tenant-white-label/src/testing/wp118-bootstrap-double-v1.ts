import type { ClinicBootstrapDouble } from '../ports.js';

export function wp118BootstrapDoubleV1(): ClinicBootstrapDouble {
  return {
    doubleId: 'wp118-bootstrap-double/v1',
    hoursFor(tenantId) {
      return { timezone: `tz:${tenantId}` };
    },
  };
}
