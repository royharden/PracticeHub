import { createHash } from 'node:crypto';

import { ReferralError } from './contracts.js';

/**
 * Pinned, versioned NPPES directory slice (WP-074 acceptance 3). The slice is
 * a synthetic extract shaped like NPPES rows; it is loaded only when both its
 * version and its content hash match the pin below. A new slice is a new
 * version with a new pin, never an in-place edit. A directory listing is
 * contact data only: it never implies that a destination accepted care
 * (REQ-REF-006 EX1) and never reroutes open referrals (REQ-REF-012 EX1).
 */
export const DIRECTORY_PIN = {
  version: 'nppes-slice-v1',
  sha256: '3b1117f9c962659d4e7cf265b48b853818d9522b2d1eb075b65d8c898a2f88f0',
} as const;

export interface DirectoryEntry {
  readonly npi: string;
  readonly name: string;
  readonly taxonomy: string;
  readonly state: string;
  readonly location: string;
  readonly fax: string | null;
  readonly espAddress: string | null;
  readonly active: boolean;
}

export interface DirectorySlice {
  readonly version: string;
  readonly synthetic: true;
  readonly entries: readonly DirectoryEntry[];
}

export interface PinnedDirectory {
  readonly version: string;
  readonly sha256: string;
  lookup(npi: string): DirectoryEntry;
  entries(): readonly DirectoryEntry[];
}

/** Stable JSON: object keys sorted at every depth, so the hash ignores key order and whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sliceDigest(slice: DirectorySlice): string {
  return createHash('sha256').update(canonicalJson(slice), 'utf8').digest('hex');
}

/** NPI check digit: Luhn over the prefix 80840 plus the first nine digits. */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) {
    return false;
  }
  const digits = `80840${npi}`.split('').map(Number);
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    const fromRight = digits.length - 1 - index;
    let digit = digits[index] ?? 0;
    if (fromRight % 2 === 1) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function isEntry(value: unknown): value is DirectoryEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<DirectoryEntry>;
  return (
    typeof entry.npi === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.taxonomy === 'string' &&
    typeof entry.state === 'string' &&
    typeof entry.location === 'string' &&
    (entry.fax === null || typeof entry.fax === 'string') &&
    (entry.espAddress === null || typeof entry.espAddress === 'string') &&
    typeof entry.active === 'boolean'
  );
}

export function parseDirectorySlice(raw: unknown): DirectorySlice {
  if (typeof raw !== 'object' || raw === null) {
    throw new ReferralError('DIRECTORY_SHAPE', 'directory slice must be an object');
  }
  const slice = raw as Partial<DirectorySlice>;
  if (typeof slice.version !== 'string' || slice.synthetic !== true) {
    throw new ReferralError(
      'DIRECTORY_SHAPE',
      'directory slice needs a version and synthetic: true',
    );
  }
  if (!Array.isArray(slice.entries) || !slice.entries.every(isEntry)) {
    throw new ReferralError('DIRECTORY_SHAPE', 'directory entries are malformed');
  }
  const seen = new Set<string>();
  for (const entry of slice.entries) {
    if (seen.has(entry.npi)) {
      throw new ReferralError('DIRECTORY_DUPLICATE', `NPI ${entry.npi} appears more than once`);
    }
    seen.add(entry.npi);
    if (!isValidNpi(entry.npi)) {
      throw new ReferralError('DIRECTORY_NPI', `entry ${entry.npi} fails the NPI check digit`);
    }
  }
  return { version: slice.version, synthetic: true, entries: slice.entries };
}

/**
 * Load a slice against a pin. A version or hash mismatch refuses the load, so
 * a silently edited or swapped directory can never back a referral.
 */
export function loadPinnedDirectory(
  raw: unknown,
  pin: { readonly version: string; readonly sha256: string } = DIRECTORY_PIN,
): PinnedDirectory {
  const slice = parseDirectorySlice(raw);
  if (slice.version !== pin.version) {
    throw new ReferralError(
      'DIRECTORY_VERSION',
      `directory version ${slice.version} does not match pin ${pin.version}`,
    );
  }
  const digest = sliceDigest(slice);
  if (digest !== pin.sha256) {
    throw new ReferralError('DIRECTORY_HASH', `directory hash ${digest} does not match the pin`);
  }
  const byNpi = new Map(slice.entries.map((entry) => [entry.npi, entry]));
  return {
    version: slice.version,
    sha256: digest,
    lookup(npi: string): DirectoryEntry {
      const entry = byNpi.get(npi);
      if (!entry) {
        throw new ReferralError('DIRECTORY_MISS', `NPI ${npi} is not in ${slice.version}`);
      }
      return entry;
    },
    entries(): readonly DirectoryEntry[] {
      return slice.entries;
    },
  };
}
