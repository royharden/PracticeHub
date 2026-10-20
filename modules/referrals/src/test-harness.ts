/** Shared synthetic setup for the WP-074 tests. Not exported from the package. */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEspSim, createFaxSim, type ChannelScenario } from './channels.js';
import type { ConsentEvidence, ReferralCase } from './contracts.js';
import { loadPinnedDirectory, type PinnedDirectory } from './directory.js';
import { openReferral, type OpenReferralInput, type SendRails } from './loop.js';
import {
  parseWp060Fixture,
  wp024PlaceholderBlobs,
  wp060PlaceholderPort,
  type Wp060ConsultNotePort,
} from './placeholder.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');

export function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixtures, name), 'utf8')) as unknown;
}

export const NPI = {
  cardiology: '1900000013',
  imaging: '1900000021',
  orthoMn: '1900000039',
  endocrineNoContact: '1900000047',
  retiredNeurology: '1900000054',
  referrerA: '1900000062',
  referrerB: '1900000070',
} as const;

/** 2026-01-05 is a Monday; tests count days from it. */
export function day(offset: number): string {
  return new Date(Date.UTC(2026, 0, 5 + offset, 15, 0, 0)).toISOString();
}

export function directory(): PinnedDirectory {
  return loadPinnedDirectory(readFixture('nppes-slice.v1.json'));
}

export function notes(): Wp060ConsultNotePort {
  return wp060PlaceholderPort(parseWp060Fixture(readFixture('wp-060-consult-notes.json')));
}

export function rails(
  dir: PinnedDirectory,
  fax: ChannelScenario = 'delivered',
  esp: ChannelScenario = 'delivered',
): SendRails {
  return {
    directory: dir,
    fax: createFaxSim(fax),
    esp: createEspSim(esp),
    blobs: wp024PlaceholderBlobs(),
  };
}

export function baseInput(overrides: Partial<OpenReferralInput> = {}): OpenReferralInput {
  return {
    referralId: 'synthetic-referral-0001',
    tenantId: 'northwind-synthetic',
    patientRef: 'synthetic-patient-0101',
    patientState: 'NV',
    referringNpi: NPI.referrerA,
    destinationNpi: NPI.cardiology,
    reason: 'synthetic reason: exertional chest discomfort, evaluate',
    urgency: 'routine',
    location: 'las-vegas',
    expectedReturnDays: 30,
    assignedReviewerId: 'synthetic-clinician-a',
    referrerUpdatesOptOut: false,
    coordinatorId: 'synthetic-coordinator-1',
    at: day(0),
    ...overrides,
  };
}

export function consentFor(npi: string, overrides: Partial<ConsentEvidence> = {}): ConsentEvidence {
  return {
    consentRef: 'synthetic-consent-0001',
    tenantId: 'northwind-synthetic',
    patientRef: 'synthetic-patient-0101',
    recipientNpi: npi,
    expiresAt: day(365),
    writtenMn: false,
    ...overrides,
  };
}

export function opened(overrides: Partial<OpenReferralInput> = {}): ReferralCase {
  return openReferral(baseInput(overrides), directory());
}

export const RECORDS = ['synthetic-record:visit-note', 'synthetic-record:med-list'] as const;
