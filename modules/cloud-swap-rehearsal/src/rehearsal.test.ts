import { describe, expect, it } from 'vitest';

import { drillGreen } from './bindings/wp120-drill-double-v1.js';
import { portableAcross } from './bindings/wp121-portability-double-v1.js';
import { CloudSwapError, type Profile } from './contracts.js';
import { runSuite, swapConfigOnly } from './profiles.js';

const staging: Profile = {
  name: 'staging',
  region: 'us-east-1',
  secretRefs: { db: 'secret://db' },
  inlineSecrets: {},
  synthetic: true,
};

const cloud: Profile = {
  name: 'cloud-shaped',
  region: 'us-west-2',
  secretRefs: { db: 'secret://db' },
  inlineSecrets: {},
  synthetic: true,
};

describe('WP-125 cloud-swap rehearsal', () => {
  it('swaps config only and keeps the suite green', () => {
    const swapped = swapConfigOnly(staging, cloud);
    expect(swapped.name).toBe('cloud-shaped');
    expect(runSuite(staging).passed).toBe(true);
    expect(runSuite(swapped).passed).toBe(true);
    expect(drillGreen(swapped.name)).toBe(true);
    expect(portableAcross(staging.name, swapped.name)).toBe(true);
  });

  it('fails secrets-externalization lint on inline secrets', () => {
    const dirty: Profile = { ...cloud, inlineSecrets: { db: 'sk-live' } };
    expect(() => swapConfigOnly(staging, dirty)).toThrow(CloudSwapError);
  });
});
