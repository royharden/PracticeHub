import {
  WP054_PACKAGE_ID,
  WP089_PACKAGE_ID,
  type MspReason,
  type Wp054MspDetermination,
  type Wp089PostedRemit,
} from './placeholders.js';
import type { Coverage, EpisodeInput, PayerKind, RemitAdjustment } from './types.js';

export const TENANT = 'tenant-synth-01';
export const PATIENT = 'pt-synth-100';
export const AT = '2026-02-01T09:00:00Z';
export const BILLED = 20_000;

export function coverage(id: string, kind: PayerKind, options: Partial<Coverage> = {}): Coverage {
  return {
    coverageId: `cov-${id}`,
    tenantId: TENANT,
    patientId: PATIENT,
    payerId: `payer-${id}`,
    kind,
    crossoverEligible: false,
    effectiveFrom: '2025-01-01',
    effectiveTo: null,
    ...options,
  };
}

export function msp(
  reason: MspReason,
  employerSize: number | null = null,
  options: Partial<Wp054MspDetermination> = {},
): Wp054MspDetermination {
  return {
    packageId: WP054_PACKAGE_ID,
    determinationId: `msp-${reason}`,
    tenantId: TENANT,
    patientId: PATIENT,
    reason,
    employerSize,
    determinedOn: '2026-01-02',
    validThrough: '2026-12-31',
    ...options,
  };
}

export function episode(
  coverages: readonly Coverage[],
  options: Partial<EpisodeInput> = {},
): EpisodeInput {
  return {
    episodeId: 'ep-1',
    tenantId: TENANT,
    patientId: PATIENT,
    encounterId: 'enc-1',
    serviceDate: '2026-01-20',
    billedMinor: BILLED,
    accidentRelated: false,
    coverages,
    ...options,
  };
}

/** A balanced remit: billed = paid + CO write-off + PR patient responsibility. */
export function remit(
  id: string,
  payerId: string,
  controlNumber: string,
  paidMinor: number,
  prMinor: number,
  options: Partial<Wp089PostedRemit> = {},
): Wp089PostedRemit {
  const adjustments: RemitAdjustment[] = [];
  const co = BILLED - paidMinor - prMinor;
  if (co > 0) adjustments.push({ group: 'CO', reason: '45', amountMinor: co });
  if (prMinor > 0) adjustments.push({ group: 'PR', reason: '2', amountMinor: prMinor });
  return {
    packageId: WP089_PACKAGE_ID,
    remitId: `rm-${id}`,
    tenantId: TENANT,
    episodeId: 'ep-1',
    payerId,
    controlNumber,
    billedMinor: BILLED,
    paidMinor,
    adjustments,
    forwardedToPayerId: null,
    postedAt: '2026-02-10T12:00:00Z',
    ...options,
  };
}
