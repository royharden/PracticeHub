import { createHash } from 'node:crypto';

import { ReferralError, WP024_PACKAGE_ID, WP060_PACKAGE_ID } from './contracts.js';

/**
 * Named placeholders for the two unlinked dependencies of WP-074.
 * - WP-060 (clinical contracts): the finalized consult note a loop closes on.
 * - WP-024 (documents blob API): content-addressed storage for the records packet.
 * Each value carries its package id, so a later pass can swap in the real
 * port and fail loudly on anything still shaped like the placeholder.
 */

export interface Wp060ConsultNote {
  readonly packageId: typeof WP060_PACKAGE_ID;
  readonly noteRef: string;
  readonly tenantId: string;
  readonly patientRef: string;
  readonly referralId: string;
  readonly finalized: boolean;
  readonly authoredBy: string;
}

export interface Wp060ConsultNoteFixture {
  readonly packageId: typeof WP060_PACKAGE_ID;
  readonly standsFor: string;
  readonly notes: readonly Wp060ConsultNote[];
}

export interface Wp060ConsultNotePort {
  readonly packageId: typeof WP060_PACKAGE_ID;
  get(noteRef: string): Wp060ConsultNote;
}

function isNote(value: unknown): value is Wp060ConsultNote {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const note = value as Partial<Wp060ConsultNote>;
  return (
    note.packageId === WP060_PACKAGE_ID &&
    typeof note.noteRef === 'string' &&
    typeof note.tenantId === 'string' &&
    typeof note.patientRef === 'string' &&
    typeof note.referralId === 'string' &&
    typeof note.finalized === 'boolean' &&
    typeof note.authoredBy === 'string'
  );
}

export function parseWp060Fixture(raw: unknown): Wp060ConsultNoteFixture {
  if (typeof raw !== 'object' || raw === null) {
    throw new ReferralError('WP060_FIXTURE', 'WP-060 fixture must be an object');
  }
  const fixture = raw as Partial<Wp060ConsultNoteFixture>;
  if (fixture.packageId !== WP060_PACKAGE_ID || typeof fixture.standsFor !== 'string') {
    throw new ReferralError('WP060_FIXTURE', 'WP-060 fixture packageId must be WP-060');
  }
  if (!Array.isArray(fixture.notes) || !fixture.notes.every(isNote)) {
    throw new ReferralError('WP060_FIXTURE', 'WP-060 fixture notes must use package WP-060');
  }
  return { packageId: WP060_PACKAGE_ID, standsFor: fixture.standsFor, notes: fixture.notes };
}

export function wp060PlaceholderPort(fixture: Wp060ConsultNoteFixture): Wp060ConsultNotePort {
  const byRef = new Map(fixture.notes.map((note) => [note.noteRef, note]));
  return {
    packageId: WP060_PACKAGE_ID,
    get(noteRef: string): Wp060ConsultNote {
      const note = byRef.get(noteRef);
      if (!note) {
        throw new ReferralError('WP060_NOTE_MISSING', `consult note ${noteRef} is unknown`);
      }
      return note;
    },
  };
}

export interface Wp024BlobPort {
  readonly packageId: typeof WP024_PACKAGE_ID;
  put(tenantId: string, bytes: string): string;
  has(ref: string): boolean;
}

/** In-memory content-addressed store standing for the WP-024 BlobStore port. */
export function wp024PlaceholderBlobs(): Wp024BlobPort {
  const stored = new Set<string>();
  return {
    packageId: WP024_PACKAGE_ID,
    put(tenantId: string, bytes: string): string {
      const digest = createHash('sha256').update(`${tenantId}\n${bytes}`, 'utf8').digest('hex');
      const ref = `blob:${tenantId}:sha256:${digest}`;
      stored.add(ref);
      return ref;
    },
    has(ref: string): boolean {
      return stored.has(ref);
    },
  };
}
