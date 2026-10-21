import { describe, expect, it } from 'vitest';

import { createEspSim, createFaxSim } from './channels.js';
import { ReferralError } from './contracts.js';
import {
  DIRECTORY_PIN,
  isValidNpi,
  loadPinnedDirectory,
  parseDirectorySlice,
  sliceDigest,
} from './directory.js';
import { NPI, readFixture } from './test-harness.js';

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ReferralError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected a ReferralError');
}

describe('WP-074 pinned NPPES directory slice', () => {
  it('loads the committed slice only under its pinned version and hash', () => {
    const directory = loadPinnedDirectory(readFixture('nppes-slice.v1.json'));
    expect(directory.version).toBe('nppes-slice-v1');
    expect(directory.sha256).toBe(DIRECTORY_PIN.sha256);
    expect(directory.entries()).toHaveLength(7);
    expect(directory.lookup(NPI.cardiology).espAddress).toBe('esp:synthetic-cardiology');
  });

  it('refuses a slice whose content changed under the same version', () => {
    const raw = readFixture('nppes-slice.v1.json') as { entries: { fax: string | null }[] };
    const first = raw.entries[0];
    if (!first) {
      throw new Error('slice has no entries');
    }
    first.fax = 'synthetic-fax:+1-555-0199';
    expect(codeOf(() => loadPinnedDirectory(raw))).toBe('DIRECTORY_HASH');
  });

  it('refuses a slice under another version even when its hash is re-pinned', () => {
    const raw = { ...(readFixture('nppes-slice.v1.json') as object), version: 'nppes-slice-v2' };
    const digest = sliceDigest(parseDirectorySlice(raw));
    expect(codeOf(() => loadPinnedDirectory(raw))).toBe('DIRECTORY_VERSION');
    expect(loadPinnedDirectory(raw, { version: 'nppes-slice-v2', sha256: digest }).version).toBe(
      'nppes-slice-v2',
    );
  });

  it('hashes canonically, so key order does not change the digest', () => {
    const slice = parseDirectorySlice(readFixture('nppes-slice.v1.json'));
    const reordered = {
      entries: slice.entries.map((entry) => Object.fromEntries(Object.entries(entry).reverse())),
      synthetic: true,
      version: slice.version,
    };
    expect(sliceDigest(parseDirectorySlice(reordered))).toBe(DIRECTORY_PIN.sha256);
  });

  it('checks the NPI check digit and refuses unknown NPIs', () => {
    expect(isValidNpi(NPI.cardiology)).toBe(true);
    expect(isValidNpi('1900000012')).toBe(false);
    expect(isValidNpi('190000001')).toBe(false);
    const raw = readFixture('nppes-slice.v1.json') as { entries: { npi: string }[] };
    const first = raw.entries[0];
    if (!first) {
      throw new Error('slice has no entries');
    }
    first.npi = '1900000012';
    expect(codeOf(() => parseDirectorySlice(raw))).toBe('DIRECTORY_NPI');
    const directory = loadPinnedDirectory(readFixture('nppes-slice.v1.json'));
    expect(codeOf(() => directory.lookup('1234567893'))).toBe('DIRECTORY_MISS');
  });
});

describe('WP-074 fax-sim and esp-sim rails', () => {
  it('returns synthetic transport receipts and refuses the wrong address kind', () => {
    const fax = createFaxSim();
    const receipt = fax.send({
      referralId: 'synthetic-referral-0001',
      address: 'synthetic-fax:+1-555-0102',
      artifactRefs: [],
      at: '2026-01-05T15:00:00.000Z',
    });
    expect(receipt).toEqual({
      transmissionId: 'fax-sim:synthetic-referral-0001:1',
      channel: 'fax',
      status: 'delivered',
      at: '2026-01-05T15:00:00.000Z',
      synthetic: true,
    });
    const esp = createEspSim('invalid-address');
    expect(
      esp.send({ referralId: 'r', address: 'esp:synthetic-x', artifactRefs: [], at: 'now' }).status,
    ).toBe('invalid-address');
    expect(
      codeOf(() =>
        esp.send({ referralId: 'r', address: 'synthetic-fax:+1', artifactRefs: [], at: 'now' }),
      ),
    ).toBe('CHANNEL_ADDRESS');
  });
});
