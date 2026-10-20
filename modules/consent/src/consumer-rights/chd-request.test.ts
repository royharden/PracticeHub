import { describe, expect, it } from 'vitest';

import {
  actOnChdRequest,
  appealChdDecision,
  CHD_RULESET_V1,
  chdMarketingAllowed,
  chdSaleAllowed,
  decideChdAppeal,
  extendChdDeadline,
  submitChdRequest,
  verifyChdRequester,
  type DataInventoryItem,
  type ProcessorPort,
} from './chd-request.js';
import { ConsumerRightsError } from './contracts.js';
import { placeholderIdentity } from './placeholders.js';

const tenant = 'northwind-synthetic';
const t0 = '2026-03-02T15:00:00.000Z';
const at = (days: number): string => new Date(Date.parse(t0) + days * 86_400_000).toISOString();

const identity = placeholderIdentity([
  { tenantId: tenant, personRef: 'synthetic-person-verified', outcome: 'verified' },
  { tenantId: tenant, personRef: 'synthetic-person-ambiguous', outcome: 'ambiguous' },
]);

const inventory: readonly DataInventoryItem[] = [
  {
    itemRef: 'chd-quiz-0001',
    dataClass: 'chd',
    purpose: 'marketing quiz',
    processor: 'synthetic-crm',
    consentRef: 'synthetic-optin-0001',
    sharedWith: ['synthetic-ad-partner'],
    sold: false,
    retentionBasis: 'none',
  },
  {
    itemRef: 'chd-wearable-0002',
    dataClass: 'chd',
    purpose: 'pre-patient wearable connect',
    processor: 'synthetic-wearable-hub',
    consentRef: 'synthetic-optin-0002',
    sharedWith: [],
    sold: false,
    retentionBasis: 'none',
  },
  {
    itemRef: 'chd-lead-0003',
    dataClass: 'chd',
    purpose: 'lead intake',
    processor: 'synthetic-crm',
    consentRef: 'synthetic-optin-0003',
    sharedWith: [],
    sold: false,
    retentionBasis: 'legal-hold',
  },
  {
    itemRef: 'clinical-note-0004',
    dataClass: 'hipaa-clinical',
    purpose: 'treatment',
    processor: 'practicehub',
    consentRef: null,
    sharedWith: [],
    sold: false,
    retentionBasis: 'required-retention',
  },
];

function processors(deleted: string[]): readonly ProcessorPort[] {
  return ['synthetic-crm', 'synthetic-wearable-hub'].map((processor) => ({
    processor,
    deleteCopy(itemRef: string) {
      deleted.push(itemRef);
      return { receiptRef: `receipt:${processor}:${itemRef}`, deleted: true };
    },
  }));
}

function code(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ConsumerRightsError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

describe('NV CHD request -> verify -> act -> appeal end to end', () => {
  it('deletes eligible CHD copies with receipts, keeps the clinical record, and runs an appeal', () => {
    let request = submitChdRequest({
      requestId: 'chd-req-1',
      tenantId: tenant,
      personRef: 'synthetic-person-verified',
      kind: 'deletion',
      at: t0,
    });
    expect(request.rulesetVersion).toBe(CHD_RULESET_V1.version);
    expect(request.dueAt).toBe(at(45));
    expect(request.marketingBlocked).toBe(true);
    expect(chdMarketingAllowed([request], tenant, 'synthetic-person-verified')).toBe(false);

    request = verifyChdRequester(
      request,
      identity,
      'synthetic-id-evidence',
      at(1),
      'privacy-officer-1',
    );
    expect(request.state).toBe('verified');

    const deleted: string[] = [];
    request = actOnChdRequest(request, inventory, processors(deleted), at(10), 'privacy-officer-1');
    expect(request.state).toBe('fulfilled');
    expect(deleted).toEqual(['chd-quiz-0001', 'chd-wearable-0002']);
    expect(request.decision?.receipts.map((receipt) => receipt.receiptRef)).toEqual([
      'receipt:synthetic-crm:chd-quiz-0001',
      'receipt:synthetic-wearable-hub:chd-wearable-0002',
    ]);
    expect(request.decision?.retained.map((item) => [item.itemRef, item.dataClass])).toEqual([
      ['clinical-note-0004', 'hipaa-clinical'],
      ['chd-lead-0003', 'chd'],
    ]);
    expect(deleted).not.toContain('clinical-note-0004');
    expect(request.appealRoute).toEqual({ owner: 'privacy-officer-1', fileBy: at(55) });

    request = appealChdDecision(request, 'the lead record should also be deleted', at(12));
    expect(request.state).toBe('appealed');
    expect(request.appeal?.dueAt).toBe(at(57));
    expect(code(() => decideChdAppeal(request, 'upheld', 'someone-else', at(20)))).toBe(
      'CHD_APPEAL',
    );
    const upheld = decideChdAppeal(request, 'upheld', 'privacy-officer-1', at(20));
    expect(upheld.state).toBe('appeal-upheld');
    expect(upheld.marketingBlocked).toBe(true);
    expect(upheld.history.map((entry) => entry.state)).toEqual([
      'received',
      'verified',
      'fulfilled',
      'appealed',
      'appeal-upheld',
    ]);

    const reversed = decideChdAppeal(request, 'reversed', 'privacy-officer-1', at(20));
    expect(reversed.state).toBe('appeal-reversed');
    const redone = actOnChdRequest(
      reversed,
      inventory,
      processors([]),
      at(21),
      'privacy-officer-1',
    );
    expect(redone.state).toBe('fulfilled');
  });

  it('answers an access request with the CHD inventory and third parties, never clinical items', () => {
    let request = submitChdRequest({
      requestId: 'chd-req-2',
      tenantId: tenant,
      personRef: 'synthetic-person-verified',
      kind: 'access',
      at: t0,
    });
    expect(request.marketingBlocked).toBe(false);
    request = verifyChdRequester(request, identity, 'ev', at(1), 'privacy-officer-1');
    request = actOnChdRequest(request, inventory, [], at(2), 'privacy-officer-1');
    expect(request.decision?.disclosed.map((item) => item.itemRef)).toEqual([
      'chd-quiz-0001',
      'chd-wearable-0002',
      'chd-lead-0003',
    ]);
    expect(request.decision?.thirdParties).toEqual([
      'synthetic-ad-partner',
      'synthetic-crm',
      'synthetic-wearable-hub',
    ]);
  });

  it('narrows, never silently denies, an ambiguous identity, and gives a reason and appeal route', () => {
    let request = submitChdRequest({
      requestId: 'chd-req-3',
      tenantId: tenant,
      personRef: 'synthetic-person-ambiguous',
      kind: 'deletion',
      at: t0,
    });
    request = verifyChdRequester(request, identity, 'weak-evidence', at(1), 'privacy-officer-1');
    expect(request.state).toBe('narrowed');
    expect(request.narrowedReason).toContain('could not be fully verified');
    expect(request.appealRoute?.owner).toBe('privacy-officer-1');
    const deleted: string[] = [];
    request = actOnChdRequest(request, inventory, processors(deleted), at(2), 'privacy-officer-1');
    expect(deleted).toHaveLength(0);
    expect(request.marketingBlocked).toBe(true);
    expect(appealChdDecision(request, 'I can verify another way', at(3)).state).toBe('appealed');

    const unknown = verifyChdRequester(
      submitChdRequest({
        requestId: 'r4',
        tenantId: tenant,
        personRef: 'nobody',
        kind: 'access',
        at: t0,
      }),
      identity,
      'ev',
      at(1),
      'privacy-officer-1',
    );
    expect(unknown.state).toBe('denied');
    expect(unknown.narrowedReason).not.toBeNull();
    expect(unknown.appealRoute).not.toBeNull();
  });

  it('enforces the response deadline with one noticed extension', () => {
    const request = verifyChdRequester(
      submitChdRequest({
        requestId: 'chd-req-5',
        tenantId: tenant,
        personRef: 'synthetic-person-verified',
        kind: 'deletion',
        at: t0,
      }),
      identity,
      'ev',
      at(1),
      'privacy-officer-1',
    );
    // Rework 1 (F3): a late act proceeds and the breach is recorded, never refused.
    const late = actOnChdRequest(request, inventory, processors([]), at(46), 'po');
    expect(late.state).toBe('fulfilled');
    expect(late.exceptions).toEqual([
      {
        kind: 'response-overdue',
        at: at(46),
        owner: 'po',
        daysLate: 1,
        detail: `acted 1 day(s) after ${at(45)}`,
      },
    ]);
    const extended = extendChdDeadline(request, at(40));
    expect(extended.dueAt).toBe(at(90));
    expect(actOnChdRequest(extended, inventory, processors([]), at(60), 'po').state).toBe(
      'fulfilled',
    );
    expect(code(() => extendChdDeadline(extended, at(41)))).toBe('CHD_EXTENSION');
  });
});

describe('CHD sale needs its own written authorization (R6-SR-021)', () => {
  const base = {
    tenantId: tenant,
    personRef: 'synthetic-person-verified',
    purchaser: 'synthetic-data-buyer',
    written: true,
    signedAt: t0,
    expiresAt: at(365),
    bundledWith: [] as string[],
    revokedAt: null,
  };

  it('sells nothing by default and refuses bundled, unwritten, revoked or expired authorizations', () => {
    expect(chdSaleAllowed([], tenant, base.personRef, base.purchaser, at(1))).toBe(false);
    expect(
      chdSaleAllowed(
        [{ ...base, bundledWith: ['marketing-optin'] }],
        tenant,
        base.personRef,
        base.purchaser,
        at(1),
      ),
    ).toBe(false);
    expect(
      chdSaleAllowed([{ ...base, written: false }], tenant, base.personRef, base.purchaser, at(1)),
    ).toBe(false);
    expect(
      chdSaleAllowed(
        [{ ...base, revokedAt: at(2) }],
        tenant,
        base.personRef,
        base.purchaser,
        at(3),
      ),
    ).toBe(false);
    expect(chdSaleAllowed([base], tenant, base.personRef, base.purchaser, at(400))).toBe(false);
    expect(chdSaleAllowed([base], tenant, base.personRef, 'another-buyer', at(1))).toBe(false);
    expect(chdSaleAllowed([base], tenant, base.personRef, base.purchaser, at(1))).toBe(true);
  });
});
