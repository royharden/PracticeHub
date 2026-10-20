import { describe, expect, it } from 'vitest';

import { assessLoa } from './number-inventory.js';
import {
  evidence,
  inventory,
  loa,
  numberA,
  numberB,
  otherTenant,
  profile,
  tenant,
} from './synthetic.js';

const profiles = [profile(numberA), profile(numberB)];

describe('WP-115 number inventory and LOA tooling', () => {
  it('marks both numbers portable when evidence, LOA and service profile agree', () => {
    expect(assessLoa(loa, inventory, evidence, profiles)).toEqual({
      tenantId: tenant,
      loaRef: 'loa-synthetic-1',
      portableNumberRefs: [numberA, numberB],
      blocked: [],
    });
  });

  it('blocks a number without owner-of-record evidence and names the reason', () => {
    const result = assessLoa(loa, inventory, evidence.slice(0, 1), profiles);
    expect(result.portableNumberRefs).toEqual([numberA]);
    expect(result.blocked).toEqual([
      { numberRef: numberB, reasons: ['owner-of-record-evidence-missing'] },
    ]);
  });

  it('blocks every number on an unsigned or mismatched LOA', () => {
    const result = assessLoa(
      { ...loa, signedAt: null, billingName: 'Someone Else LLC', signerRef: 'signer-unknown' },
      inventory,
      evidence,
      profiles,
    );
    expect(result.portableNumberRefs).toEqual([]);
    expect(result.blocked[0]?.reasons).toEqual([
      'loa-unsigned',
      'billing-name-mismatch',
      'signer-not-authorized',
    ]);
  });

  it('blocks numbers missing E911, 10DLC, inbound route or a rollback fallback', () => {
    const result = assessLoa(loa, inventory, evidence, [
      { ...profile(numberA), e911AddressRef: null, forwardingFallbackRef: null },
      { ...profile(numberB), tenDlcCampaignRef: null, inboundRouteRef: null },
    ]);
    expect(result.blocked).toEqual([
      { numberRef: numberA, reasons: ['e911-address-missing', 'rollback-fallback-missing'] },
      { numberRef: numberB, reasons: ['10dlc-campaign-missing', 'inbound-route-missing'] },
    ]);
  });

  it('refuses numbers outside the fiction range, off-inventory, duplicated or owned by another tenant', () => {
    // 555 but outside the 555-0100..0199 fiction block, so it must be refused.
    const real = '+17025559999';
    const [first, second] = inventory;
    if (first === undefined || second === undefined) throw new Error('inventory fixture');
    const result = assessLoa(
      { ...loa, numberRefs: [numberA, numberA, real, numberB] },
      [first, { ...second, tenantId: otherTenant }],
      evidence,
      profiles,
    );
    expect(result.portableNumberRefs).toEqual([]);
    expect(result.blocked.find((block) => block.numberRef === numberA)?.reasons).toEqual([
      'duplicate-number-on-loa',
    ]);
    expect(result.blocked.find((block) => block.numberRef === numberB)?.reasons).toEqual([
      'number-belongs-to-another-tenant',
    ]);
    expect(result.blocked.find((block) => block.numberRef === real)?.reasons).toContain(
      'number-not-synthetic-fiction-range',
    );
  });
});
