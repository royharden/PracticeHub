import { describe, expect, it } from 'vitest';

import { CashGfeIssuer, type CashGfeDocument, type CashGfeError } from './gfe-issue.js';

const document = (): CashGfeDocument => ({
  tenantId: 'northwind-synthetic',
  gfeRef: 'gfe:nwind-gfe-0001',
  contentSha256: 'a'.repeat(64),
  gfeTotalMinor: 18798,
  claimTotalMinor: 22000,
  lines: [
    {
      lineRef: 'line:visit-99213-01',
      expectedAmountMinor: 15000,
      coverage: 'non-covered',
      partyKind: 'provider',
      partyRef: 'party:prov-convene01',
      partyRole: 'convening',
    },
    {
      lineRef: 'line:visit-99214-01',
      expectedAmountMinor: 22000,
      coverage: 'covered',
      partyKind: 'provider',
      partyRef: 'party:prov-convene01',
      partyRole: 'convening',
    },
    {
      lineRef: 'line:lab-80053-0001',
      expectedAmountMinor: 3798,
      coverage: 'non-covered',
      partyKind: 'facility',
      partyRef: 'party:fac-lab000001',
      partyRole: 'co-facility',
    },
  ],
});

describe('WP-051 cash GFE issue', () => {
  it('binds a purchase to self-pay lines and keeps covered amounts off the GFE', () => {
    const issuer = new CashGfeIssuer();
    const issued = issuer.issue({
      tenantId: 'northwind-synthetic',
      purchaseKey: 'purchase-nwind-01',
      document: document(),
    });
    expect(issued.document.gfeTotalMinor).toBe(18798);
    expect(issued.document.claimTotalMinor).toBe(22000);
  });

  it('refuses a GFE total that includes the covered amount', () => {
    const issuer = new CashGfeIssuer();
    const leaked = document();
    expect(() =>
      issuer.issue({
        tenantId: 'northwind-synthetic',
        purchaseKey: 'purchase-nwind-01',
        document: { ...leaked, gfeTotalMinor: 18798 + 22000 },
      }),
    ).toThrow(expect.objectContaining({ code: 'CLAIM_ON_GFE' } satisfies Partial<CashGfeError>));
  });

  it('flags a $400.00 cash variance and does not flag $399.99', () => {
    const issuer = new CashGfeIssuer();
    issuer.issue({
      tenantId: 'northwind-synthetic',
      purchaseKey: 'purchase-nwind-01',
      document: document(),
    });
    expect(
      issuer.variance({
        tenantId: 'northwind-synthetic',
        purchaseKey: 'purchase-nwind-01',
        actualTotalMinor: 18798 + 39999,
      }).flagged,
    ).toBe(false);
    expect(
      issuer.variance({
        tenantId: 'northwind-synthetic',
        purchaseKey: 'purchase-nwind-01',
        actualTotalMinor: 18798 + 40000,
      }),
    ).toMatchObject({ deltaMinor: 40000, flagged: true });
  });

  it('refuses a line with no party', () => {
    const issuer = new CashGfeIssuer();
    const broken = document();
    const [first, ...rest] = broken.lines;
    if (first === undefined) throw new Error('fixture missing line');
    expect(() =>
      issuer.issue({
        tenantId: 'northwind-synthetic',
        purchaseKey: 'purchase-nwind-01',
        document: {
          ...broken,
          lines: [{ ...first, partyRef: '' }, ...rest],
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'ATTRIBUTION' }));
  });
});
