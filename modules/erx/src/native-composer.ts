import { wp062MedicationListPlaceholder } from './erx.js';

export interface PrescriptionDraft {
  readonly draftId: string;
  readonly prescriberNpi: string;
  readonly medicationRef: string;
  readonly sig: string;
  readonly jurisdiction: string;
}

export interface ComposedPrescription {
  readonly draftId: string;
  readonly prescriberNpi: string;
  readonly medicationRef: string;
  readonly sig: string;
  readonly jurisdiction: string;
  readonly medicationList: typeof wp062MedicationListPlaceholder.fixtureId;
}

export interface EpcsFactors {
  readonly password: string;
  readonly token: string;
}

/** Local stand-in for the WP-028 EPCS simulator. Both factors must match. */
export const epcsSimulator = {
  password: 'sim-password',
  token: 'sim-token',
  verify(factors: EpcsFactors): boolean {
    return factors.password === this.password && factors.token === this.token;
  },
};

export interface DirectoryEntry {
  readonly npi: string;
  readonly displayName: string;
}

export const directoryFixture: readonly DirectoryEntry[] = [
  { npi: '1234567893', displayName: 'Fixture Prescriber' },
];

export class ComposerError extends Error {
  public constructor(public readonly code: 'EPCS_DENIED' | 'DIRECTORY_MISS' | 'PDMP_REQUIRED') {
    super(code);
    this.name = 'ComposerError';
  }
}

export function lookupDirectory(npi: string): DirectoryEntry {
  const entry = directoryFixture.find((item) => item.npi === npi);
  if (entry === undefined) throw new ComposerError('DIRECTORY_MISS');
  return entry;
}

export function composePayload(draft: PrescriptionDraft): ComposedPrescription {
  lookupDirectory(draft.prescriberNpi);
  return {
    draftId: draft.draftId,
    prescriberNpi: draft.prescriberNpi,
    medicationRef: draft.medicationRef,
    sig: draft.sig,
    jurisdiction: draft.jurisdiction,
    medicationList: wp062MedicationListPlaceholder.fixtureId,
  };
}

export interface ShadowHarness {
  readonly transmits: number;
  readonly pdmpChecks: number;
  readonly composed: readonly ComposedPrescription[];
}

/**
 * Shadow mode composes the native payload and does not transmit.
 * PDMP is recorded as a hook. EPCS is checked against the simulator first.
 */
export function composeNativeShadow(
  drafts: readonly PrescriptionDraft[],
  factors: EpcsFactors,
): ShadowHarness {
  if (!epcsSimulator.verify(factors)) throw new ComposerError('EPCS_DENIED');
  const composed = drafts.map((draft) => composePayload(draft));
  return {
    transmits: 0,
    pdmpChecks: drafts.length,
    composed,
  };
}
