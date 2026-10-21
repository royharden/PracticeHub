import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { reconcileBackload, type BackloadRow } from './backload.js';
import {
  RcmShadowError,
  type MirrorBody,
  type SealedMirror,
  type Wp056LedgerPort,
  type Wp056LedgerPosting,
} from './contracts.js';
import { parseWp056Fixture, wp056PlaceholderPort } from './placeholder.js';
import { sealMirror } from './seal.js';
import { ShadowStore } from './store.js';

// WP-080 rework 1: each test here fails on the landed 639bd59 code.

const directory = dirname(fileURLToPath(import.meta.url));
const LIVE = new Set(['live-stedi-001']);
const credential = { class: 'shadow' as const, credentialId: 'shadow-rcm-001' };

function body(overrides: Partial<MirrorBody> = {}): MirrorBody {
  return {
    tenantId: 'tenant-shadow',
    kind: '835',
    controlNumber: 'CTL-100',
    amountMinor: 12500,
    currency: 'USD',
    payload: 'synthetic-835-claim-100',
    ...overrides,
  };
}

function row(overrides: Partial<BackloadRow> = {}): BackloadRow {
  return {
    tenantId: 'tenant-shadow',
    kind: '835',
    controlNumber: 'CTL-100',
    amountMinor: 12500,
    payload: 'synthetic-835-claim-100',
    ...overrides,
  };
}

function shadowJournal(): Wp056LedgerPort {
  const raw: unknown = JSON.parse(
    readFileSync(resolve(directory, '../fixtures/wp-056-ledger.json'), 'utf8'),
  );
  return wp056PlaceholderPort(parseWp056Fixture(raw));
}

describe('WP-080 rework: stored mirrors are immutable', () => {
  it('mutating the caller body after append does not change the stored mirror', () => {
    const store = new ShadowStore(LIVE, shadowJournal());
    const input = { ...body() };
    const sealed = store.append(input, credential);
    input.amountMinor = 1;
    input.payload = 'tampered';
    const stored = store.list()[0];
    expect(stored?.body.amountMinor).toBe(12500);
    expect(stored?.body.payload).toBe('synthetic-835-claim-100');
    expect(sealMirror(stored?.body ?? body()).seal).toBe(sealed.seal);
  });

  it('a returned or listed record cannot be mutated', () => {
    const store = new ShadowStore(LIVE, shadowJournal());
    const sealed = store.append(body(), credential);
    const listed = store.list()[0];
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.body)).toBe(true);
    expect(Object.isFrozen(sealed.credential)).toBe(true);
    expect(Object.isFrozen(sealed.ledgerPosting)).toBe(true);
    expect(Object.isFrozen(store.list())).toBe(true);
    expect(() => {
      (listed?.body as { amountMinor: number }).amountMinor = 1;
    }).toThrow(TypeError);
    expect(store.list()[0]?.body.amountMinor).toBe(12500);
  });
});

describe('WP-080 rework: backload verifies the seal over the compared body', () => {
  it('a body that diverged from its sealed canonical bytes is a seal conflict', () => {
    const sealed = sealMirror(body());
    const diverged: SealedMirror = {
      seal: sealed.seal,
      canonical: sealed.canonical,
      body: body({ amountMinor: 99 }),
      credential,
      ledgerPosting: null,
    };
    const report = reconcileBackload([row({ amountMinor: 99 })], [diverged]);
    expect(report.matched).toEqual([]);
    expect(report.conflicting.map((c) => c.reason)).toEqual(['seal']);
    expect(report.unmatched).toEqual([]);
  });

  it('keys the shadow side from the sealed bytes, not a re-keyed body', () => {
    const sealed = sealMirror(body());
    const rekeyed: SealedMirror = {
      seal: sealed.seal,
      canonical: sealed.canonical,
      body: body({ controlNumber: 'CTL-999' }),
      credential,
      ledgerPosting: null,
    };
    const report = reconcileBackload([row({ controlNumber: 'CTL-999' })], [rekeyed]);
    expect(report.matched).toEqual([]);
    expect(report.conflicting.map((c) => `${c.reason}:${c.key.controlNumber}`)).toEqual([
      'seal:CTL-100',
    ]);
    expect(report.unmatched.map((u) => `${u.side}:${u.key.controlNumber}`)).toEqual([
      'incumbent:CTL-999',
    ]);
  });
});

describe('WP-080 rework: the ledger port is a shadow journal only', () => {
  it('refuses a port that is not a shadow journal', () => {
    const livePostings: Wp056LedgerPosting[] = [];
    const liveLedger = {
      packageId: 'WP-056',
      journal: 'live',
      record(posting: Wp056LedgerPosting) {
        livePostings.push(posting);
        return posting;
      },
      postings: () => livePostings,
    } as unknown as Wp056LedgerPort;
    expect(() => new ShadowStore(LIVE, liveLedger)).toThrow(
      expect.objectContaining({ code: 'SHADOW_JOURNAL_REQUIRED' }),
    );
    const unmarked = { ...liveLedger, journal: undefined } as unknown as Wp056LedgerPort;
    expect(() => new ShadowStore(LIVE, unmarked)).toThrow(RcmShadowError);
    expect(livePostings).toEqual([]);
  });

  it('the placeholder port is a shadow journal', () => {
    const journal = shadowJournal();
    expect(journal.journal).toBe('shadow');
    expect(() => new ShadowStore(LIVE, journal)).not.toThrow();
  });
});

describe('WP-080 rework: backload rows', () => {
  it('reports a duplicated incumbent row instead of dropping it', () => {
    const store = new ShadowStore(LIVE, shadowJournal());
    store.append(body(), credential);
    const report = reconcileBackload(
      [
        row(),
        row({ amountMinor: 12600 }),
        row({ controlNumber: 'CTL-200', amountMinor: 5, payload: 'p' }),
      ],
      store.list(),
    );
    expect(report.matched).toEqual([]);
    expect(report.conflicting).toEqual([
      {
        key: { tenantId: 'tenant-shadow', kind: '835', controlNumber: 'CTL-100' },
        reason: 'duplicate',
        incumbentAmountMinor: 12500,
        shadowAmountMinor: 12500,
        occurrences: 2,
      },
    ]);
    expect(report.unmatched.map((u) => `${u.side}:${u.key.controlNumber}`)).toEqual([
      'incumbent:CTL-200',
    ]);
  });

  it('refuses a malformed backload row', () => {
    expect(() => reconcileBackload([row({ amountMinor: 1.5 })], [])).toThrow(RcmShadowError);
    expect(() => reconcileBackload([row({ controlNumber: 'bad key' })], [])).toThrow(
      RcmShadowError,
    );
    expect(() => reconcileBackload([row({ payload: '' })], [])).toThrow(RcmShadowError);
  });
});
