import type { BrandKitDouble, ClinicBootstrapDouble } from './ports.js';
import { WhiteLabelError, requireSynthetic } from './types.js';
import type { WhiteLabelProfile } from './types.js';

export function assembleTenant2Profile(input: {
  readonly tenantId: string;
  readonly brand: BrandKitDouble;
  readonly bootstrap: ClinicBootstrapDouble;
  readonly faxCoverRef: string;
  readonly letterheadRef: string;
  readonly printers: readonly string[];
  readonly faxNumberRef: string;
  readonly synthetic: boolean;
}): WhiteLabelProfile {
  requireSynthetic(input.synthetic);
  if (input.tenantId.trim() === '') {
    throw new WhiteLabelError('tenantId is required');
  }
  return {
    tenantId: input.tenantId,
    brand: {
      wordmark: input.brand.wordmarkFor(input.tenantId),
      primaryColor: '#0B3D5C',
    },
    hours: {
      timezone: input.bootstrap.hoursFor(input.tenantId).timezone,
      windows: [{ day: 'mon', open: '08:00', close: '17:00' }],
    },
    templates: {
      faxCoverRef: input.faxCoverRef,
      letterheadRef: input.letterheadRef,
    },
    printers: input.printers,
    faxNumberRef: input.faxNumberRef,
    synthetic: true,
  };
}
