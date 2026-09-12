import { expect, it } from 'vitest';

import type { SchedulingProviderPort } from './ports.js';
import { requireRealProviderParity } from './testing/wp032-athena-scheduling-double-v1.js';

const unavailablePort: SchedulingProviderPort = {
  adapterId: process.env['WP032_REAL_ADAPTER_ID'] ?? 'real-adapter-not-provisioned',
  adapterMode: process.env['WP032_REAL_ADAPTER_ID'] === undefined ? 'synthetic' : 'real',
  hold: async () => Promise.reject(new Error('real adapter not provisioned')),
  commit: async () => Promise.reject(new Error('real adapter not provisioned')),
  release: async () => Promise.reject(new Error('real adapter not provisioned')),
  cancel: async () => Promise.reject(new Error('real adapter not provisioned')),
};

it('requires composition-root verified real WP-032 parity evidence', () => {
  expect(() =>
    requireRealProviderParity(unavailablePort, {
      contractId: process.env['WP032_REAL_CONTRACT_ID'] ?? '',
      corpusSha256: process.env['WP032_REAL_CORPUS_SHA256'] ?? '',
      independentReviewSha256: process.env['WP032_REAL_REVIEW_SHA256'] ?? '',
      verifiedByCompositionRoot: true,
    }),
  ).not.toThrow();
});
