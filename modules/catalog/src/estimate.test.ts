import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  aggregateByParty,
  EstimateError,
  FeeScheduleBook,
  gfeRetentionRegistration,
  issueGoodFaithEstimate,
  ppdrArtifact,
  varianceAgainstGfe,
  type EstimateLineInput,
  type FeeScheduleId,
  type PartyKind,
} from './estimate.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const load = (name: string): unknown =>
  JSON.parse(readFileSync(`${root}modules/catalog/fixtures/${name}`, 'utf8')) as unknown;

interface RateFile {
  readonly schedule: FeeScheduleId;
  readonly scheduleVersionRef: string;
  readonly rates: readonly { readonly code: string; readonly unitAmountMinor: number }[];
}

interface HappyFile {
  readonly tenantId: string;
  readonly gfeRef: string;
  readonly subjectRef: string;
  readonly conveningPartyKind: PartyKind;
  readonly conveningPartyRef: string;
  readonly pfsVersionRef: string;
  readonly clfsVersionRef: string;
  readonly lines: readonly EstimateLineInput[];
  readonly expectedGfeTotalMinor: number;
  readonly expectedClaimTotalMinor: number;
}

const bookFromFixtures = (): FeeScheduleBook => {
  const book = new FeeScheduleBook();
  for (const name of ['WP-051.PFS.json', 'WP-051.CLFS.json']) {
    const file = load(name) as RateFile;
    for (const rate of file.rates) {
      book.add({
        schedule: file.schedule,
        scheduleVersionRef: file.scheduleVersionRef,
        code: rate.code,
        unitAmountMinor: rate.unitAmountMinor,
      });
    }
  }
  return book;
};

const fixtureTotal = (
  lines: readonly EstimateLineInput[],
  pfs: RateFile,
  clfs: RateFile,
  coverage: 'covered' | 'non-covered',
): number =>
  lines
    .filter((line) => line.coverage === coverage)
    .reduce((sum, line) => {
      const file = line.schedule === 'PFS' ? pfs : clfs;
      const rate = file.rates.find((row) => row.code === line.code);
      if (rate === undefined) throw new Error(`fixture missing ${line.code}`);
      return sum + rate.unitAmountMinor * line.quantity;
    }, 0);

const issueHappy = (): ReturnType<typeof issueGoodFaithEstimate> => {
  const happy = load('WP-051.HAPPY.json') as HappyFile;
  return issueGoodFaithEstimate({ ...happy, book: bookFromFixtures(), synthetic: true });
};

describe('WP-051 GFE estimates', () => {
  it('HAPPY prices self-pay lines from the PFS and CLFS fixtures and excludes covered amounts', () => {
    const happy = load('WP-051.HAPPY.json') as HappyFile;
    const pfs = load('WP-051.PFS.json') as RateFile;
    const clfs = load('WP-051.CLFS.json') as RateFile;
    const selfPay = fixtureTotal(happy.lines, pfs, clfs, 'non-covered');
    const claim = fixtureTotal(happy.lines, pfs, clfs, 'covered');
    expect(selfPay).toBe(happy.expectedGfeTotalMinor);
    expect(claim).toBe(happy.expectedClaimTotalMinor);
    const estimate = issueHappy();
    expect(estimate.gfeTotalMinor).toBe(selfPay);
    expect(estimate.claimTotalMinor).toBe(claim);
    expect(estimate.gfeTotalMinor).toBe(18798);
    expect(estimate.claimTotalMinor).toBe(22000);
    const lab = estimate.lines.find((line) => line.code === '80053');
    expect(lab?.expectedAmountMinor).toBe(3798);
    const parties = aggregateByParty(estimate);
    expect(parties).toEqual([
      {
        partyKind: 'facility',
        partyRef: 'party:fac-lab000001',
        selfPayMinor: 3798,
        claimMinor: 0,
      },
      {
        partyKind: 'provider',
        partyRef: 'party:prov-convene01',
        selfPayMinor: 15000,
        claimMinor: 22000,
      },
    ]);
    expect(gfeRetentionRegistration(estimate)).toMatchObject({
      recordClass: 'gfe-record',
      artifactRef: happy.gfeRef,
      packageId: 'WP-051',
    });
  });

  it('BOUNDARY flags $400.00 and does not flag $399.99', () => {
    const boundary = load('WP-051.BOUNDARY.json') as {
      gfeTotalMinor: number;
      below: { deltaMinor: number; actualTotalMinor: number; flagged: boolean };
      at: { deltaMinor: number; actualTotalMinor: number; flagged: boolean };
    };
    const below = varianceAgainstGfe(boundary.gfeTotalMinor, boundary.below.actualTotalMinor);
    const at = varianceAgainstGfe(boundary.gfeTotalMinor, boundary.at.actualTotalMinor);
    expect(below.deltaMinor).toBe(39999);
    expect(below.flagged).toBe(boundary.below.flagged);
    expect(at.deltaMinor).toBe(40000);
    expect(at.flagged).toBe(boundary.at.flagged);
    expect(below.flagged).toBe(false);
    expect(at.flagged).toBe(true);
    expect(ppdrArtifact('gfe:nwind-gfe-0001', below, ['ppdr-available'])).toBeNull();
    expect(ppdrArtifact('gfe:nwind-gfe-0001', at, ['ppdr-available'])).toMatchObject({
      deltaMinor: 40000,
      notices: ['ppdr-available'],
    });
  });

  it('FAILURE refuses a missing fee-schedule code and a convening party tagged as co-provider', () => {
    const failure = load('WP-051.FAILURE.json') as { missingCode: string };
    const happy = load('WP-051.HAPPY.json') as HappyFile;
    const visit = happy.lines[0];
    if (visit === undefined) throw new Error('fixture missing convening line');
    expect(() =>
      issueGoodFaithEstimate({
        ...happy,
        book: bookFromFixtures(),
        synthetic: true,
        lines: [{ ...visit, code: failure.missingCode }],
      }),
    ).toThrow(EstimateError);
    expect(() =>
      issueGoodFaithEstimate({
        ...happy,
        book: bookFromFixtures(),
        synthetic: true,
        lines: [{ ...visit, partyRole: 'co-provider' }],
      }),
    ).toThrow(expect.objectContaining({ code: 'ATTRIBUTION' }));
  });

  it('RECOVERY keeps the GFE, assembles PPDR at the threshold, and clears under it', () => {
    const recovery = load('WP-051.RECOVERY.json') as {
      recordClass: 'gfe-record';
      packageId: 'WP-051';
      notices: string[];
    };
    const estimate = issueHappy();
    const registration = gfeRetentionRegistration(estimate);
    expect(registration.recordClass).toBe(recovery.recordClass);
    expect(registration.packageId).toBe(recovery.packageId);
    const flagged = varianceAgainstGfe(estimate.gfeTotalMinor, estimate.gfeTotalMinor + 40000);
    const artifact = ppdrArtifact(estimate.gfeRef, flagged, recovery.notices);
    expect(artifact).toMatchObject({
      gfeRef: estimate.gfeRef,
      gfeTotalMinor: estimate.gfeTotalMinor,
      deltaMinor: 40000,
    });
    const cleared = varianceAgainstGfe(estimate.gfeTotalMinor, estimate.gfeTotalMinor + 39999);
    expect(cleared.flagged).toBe(false);
    expect(ppdrArtifact(estimate.gfeRef, cleared, recovery.notices)).toBeNull();
    expect(registration.contentSha256).toBe(estimate.contentSha256);
  });
});
