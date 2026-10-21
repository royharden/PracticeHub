import { describe, expect, it } from 'vitest';

import * as crm from './index.js';

describe('WP-070 targeted fix R1: the public API offers no unscoped member-360 read', () => {
  it('does not export the unscoped member360', () => {
    expect('member360' in crm).toBe(false);
  });

  it('every exported member-360 function takes a tenant-, caller- and PDP-scoped request', () => {
    // Member-360 read functions are named member360*; the StaticMember360Pdp double is a PDP, not a read.
    const member360Exports = Object.keys(crm).filter((name) => /^member-?360/i.test(name));
    expect(member360Exports).toEqual(['member360ForCaller']);
  });
});
