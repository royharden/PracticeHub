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

// Rework 1 (review D48-WP-058-cc-review-1, F2 and F3). Each case fails on 2390dd1.
describe('WP-051 cash GFE issue rework: tenancy and convening attribution', () => {
  const codeOf = (action: () => unknown): string => {
    try {
      action();
    } catch (error) {
      return (error as CashGfeError).code;
    }
    return 'NO_ERROR';
  };

  it('refuses a document that belongs to another tenant and stores nothing', () => {
    const issuer = new CashGfeIssuer();
    expect(
      codeOf(() =>
        issuer.issue({
          tenantId: 'riverbend-synthetic',
          purchaseKey: 'purchase-nwind-02',
          document: document(),
        }),
      ),
    ).toBe('GFE_INVALID');
    expect(
      codeOf(() =>
        issuer.variance({
          tenantId: 'riverbend-synthetic',
          purchaseKey: 'purchase-nwind-02',
          actualTotalMinor: 0,
        }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('refuses an estimate with no convening party', () => {
    const issuer = new CashGfeIssuer();
    const noConvening = document().lines.filter((line) => line.partyRole !== 'convening');
    expect(
      codeOf(() =>
        issuer.issue({
          tenantId: 'northwind-synthetic',
          purchaseKey: 'purchase-nwind-03',
          document: { ...document(), gfeTotalMinor: 3798, claimTotalMinor: 0, lines: noConvening },
        }),
      ),
    ).toBe('ATTRIBUTION');
  });

  it('refuses two different convening parties on one estimate', () => {
    const issuer = new CashGfeIssuer();
    const doc = document();
    const lines = doc.lines.map((line, index) =>
      index === 1 ? { ...line, partyRef: 'party:prov-convene02' } : line,
    );
    expect(
      codeOf(() =>
        issuer.issue({
          tenantId: 'northwind-synthetic',
          purchaseKey: 'purchase-nwind-04',
          document: { ...doc, lines },
        }),
      ),
    ).toBe('ATTRIBUTION');
  });
});
