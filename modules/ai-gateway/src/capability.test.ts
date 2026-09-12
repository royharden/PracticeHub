import {
  capabilityRegistryV1,
  type CapabilityGrant,
  type CapabilityRegistry,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { RegistryInferenceAuthorization } from './capability.js';
import { requestFixture } from './test-support.js';

const registry: CapabilityRegistry = {
  ...capabilityRegistryV1,
  definitions: [
    ...capabilityRegistryV1.definitions,
    {
      capabilityId: 'ai.gateway',
      ownerRole: 'security',
      dimensions: ['feature', 'cohort'],
      requiredDimensions: ['feature', 'cohort'],
      precedence: ['feature', 'cohort'],
      description: 'Synthetic AI inference boundary.',
    },
  ],
};

function grant(state: CapabilityGrant['state']): CapabilityGrant {
  return {
    capabilityId: 'ai.gateway',
    tenantId: 'northwind-synthetic',
    scope: { feature: 'draft-visit-summary', cohort: 'cohort-alpha' },
    state,
    sinceEventId: 'synthetic-cap-ai-0002',
    evidenceRefs: ['synthetic-gate:wp-100'],
    rollbackRef: 'disable-ai-gateway',
    synthetic: true,
  };
}

describe('RegistryInferenceAuthorization', () => {
  it('requires the exact feature/cohort grant at the simulated floor', () => {
    const request = requestFixture();
    expect(
      new RegistryInferenceAuthorization(registry, [grant('simulated')]).authorize(request).allowed,
    ).toBe(true);
    expect(
      new RegistryInferenceAuthorization(registry, [grant('scaffolded')]).authorize(request)
        .allowed,
    ).toBe(false);
    expect(
      new RegistryInferenceAuthorization(registry, [
        { ...grant('simulated'), scope: { feature: 'draft-visit-summary', cohort: 'cohort-beta' } },
      ]).authorize(request).allowed,
    ).toBe(false);
  });
});
