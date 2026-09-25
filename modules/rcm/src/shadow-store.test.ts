import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { reconcileBackload, type BackloadRow } from './backload.js';
import {
  RcmShadowError,
  WP056_PACKAGE_ID,
  type MirrorBody,
  type SealedMirror,
} from './contracts.js';
import { parseWp056Fixture, wp056PlaceholderPort } from './placeholder.js';
import { sealCanonical, sealMirror } from './seal.js';
import { ShadowStore } from './store.js';

const directory = dirname(fileURLToPath(import.meta.url));
const LIVE = new Set(['live-stedi-001']);

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

function loadPort() {
  const raw: unknown = JSON.parse(
    readFileSync(resolve(directory, '../fixtures/wp-056-ledger.json'), 'utf8'),
  );
  const fixture = parseWp056Fixture(raw);
  return { fixture, ledger: wp056PlaceholderPort(fixture) };
}

describe('WP-080 sealed 835/837 mirror', () => {
  it('seals the same body the same way and changes the seal when an input changes', () => {
    const first = sealMirror(body());
    const again = sealMirror(body());
    const changedAmount = sealMirror(body({ amountMinor: 12501 }));
    const changedPayload = sealMirror(body({ payload: 'synthetic-835-claim-100-b' }));
    expect(again.seal).toBe(first.seal);
    expect(changedAmount.seal).not.toBe(first.seal);
    expect(changedPayload.seal).not.toBe(first.seal);
    expect(sealCanonical(first.canonical)).toBe(first.seal);
  });

  it('keeps shadow credentials distinct from live rail credentials', () => {
    const { ledger } = loadPort();
    const store = new ShadowStore(LIVE, ledger);
    expect(() =>
      store.append(body(), { class: 'live', credentialId: 'live-stedi-001', railId: 'stedi' }),
    ).toThrow(RcmShadowError);
    expect(() => store.append(body(), { class: 'shadow', credentialId: 'live-stedi-001' })).toThrow(
      RcmShadowError,
    );
    const sealed = store.append(body(), { class: 'shadow', credentialId: 'shadow-rcm-001' });
    expect(sealed.credential).toEqual({ class: 'shadow', credentialId: 'shadow-rcm-001' });
    expect(LIVE.has(sealed.credential.credentialId)).toBe(false);
    expect(JSON.stringify(sealed)).not.toContain('live-stedi-001');
    expect(JSON.stringify(sealed)).not.toContain('"class":"live"');
  });

  it('does not replace a sealed mirror and posts an 835 only through WP-056', () => {
    const { fixture, ledger } = loadPort();
    expect(fixture.packageId).toBe(WP056_PACKAGE_ID);
    expect(fixture.postings[0]?.packageId).toBe('WP-056');
    const store = new ShadowStore(LIVE, ledger);
    const sealed = store.append(body(), { class: 'shadow', credentialId: 'shadow-rcm-001' });
    const repeated = store.append(body(), { class: 'shadow', credentialId: 'shadow-rcm-001' });
    expect(repeated.seal).toBe(sealed.seal);
    expect(ledger.postings()).toHaveLength(fixture.postings.length + 1);
    expect(sealed.ledgerPosting?.packageId).toBe('WP-056');
    expect(sealed.ledgerPosting?.sourceSeal).toBe(sealed.seal);
    expect(() =>
      store.append(body({ amountMinor: 1 }), { class: 'shadow', credentialId: 'shadow-rcm-001' }),
    ).toThrow(RcmShadowError);
    expect(store.list()[0]?.seal).toBe(sealed.seal);

    const claim = store.append(
      body({ kind: '837', controlNumber: 'CTL-837', payload: 'synthetic-837' }),
      {
        class: 'shadow',
        credentialId: 'shadow-rcm-001',
      },
    );
    expect(claim.ledgerPosting).toBeNull();
    expect(ledger.postings()).toHaveLength(fixture.postings.length + 1);
  });
});

describe('WP-080 historical backload', () => {
  it('reports matched, unmatched, and conflicting rows', () => {
    const { ledger } = loadPort();
    const store = new ShadowStore(LIVE, ledger);
    const credential = { class: 'shadow' as const, credentialId: 'shadow-rcm-001' };
    store.append(body(), credential);
    store.append(
      body({ controlNumber: 'CTL-200', amountMinor: 20, payload: 'synthetic-200' }),
      credential,
    );
    store.append(
      body({ controlNumber: 'CTL-400', amountMinor: 40, payload: 'synthetic-400' }),
      credential,
    );

    const incumbent: BackloadRow[] = [
      {
        tenantId: 'tenant-shadow',
        kind: '835',
        controlNumber: 'CTL-100',
        amountMinor: 12500,
        payload: 'synthetic-835-claim-100',
      },
      {
        tenantId: 'tenant-shadow',
        kind: '835',
        controlNumber: 'CTL-200',
        amountMinor: 10,
        payload: 'synthetic-200',
      },
      {
        tenantId: 'tenant-shadow',
        kind: '835',
        controlNumber: 'CTL-300',
        amountMinor: 30,
        payload: 'synthetic-300',
      },
    ];

    const report = reconcileBackload(incumbent, store.list());
    expect(report.matched.map((row) => row.controlNumber)).toEqual(['CTL-100']);
    expect(report.conflicting.map((row) => row.reason)).toEqual(['amount']);
    expect(report.conflicting[0]?.key.controlNumber).toBe('CTL-200');
    expect(report.unmatched.map((row) => `${row.side}:${row.key.controlNumber}`).sort()).toEqual([
      'incumbent:CTL-300',
      'shadow:CTL-400',
    ]);
  });

  it('classifies a changed seal as a conflict', () => {
    const stored = sealMirror(body());
    const tampered: SealedMirror = {
      seal: '0'.repeat(64),
      canonical: stored.canonical,
      body: body(),
      credential: { class: 'shadow', credentialId: 'shadow-rcm-001' },
      ledgerPosting: null,
    };
    const report = reconcileBackload(
      [
        {
          tenantId: 'tenant-shadow',
          kind: '835',
          controlNumber: 'CTL-100',
          amountMinor: 12500,
          payload: 'synthetic-835-claim-100',
        },
      ],
      [tampered],
    );
    expect(report.matched).toHaveLength(0);
    expect(report.conflicting[0]?.reason).toBe('seal');
  });
});
