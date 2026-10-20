import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  ERX_JURISDICTION_TOPIC,
  fixtureJurisdictionPort,
  JURISDICTION_HARD_BLOCK,
  wp062MedicationListPlaceholder,
  type ErxJurisdictionPort,
} from './erx.js';

export type ControlledSchedule = 'II' | 'III' | 'IV' | 'V';

export interface PrescriptionDraft {
  readonly draftId: string;
  readonly prescriberNpi: string;
  readonly medicationRef: string;
  readonly sig: string;
  readonly jurisdiction: string;
  /** DEA schedule for a controlled substance; absent or null for a non-controlled drug. */
  readonly controlledSchedule?: ControlledSchedule | null;
  /** Patient the prescription is for; part of the content an EPCS signature commits to. */
  readonly patientRef?: string;
  /** Dispense quantity; part of the content an EPCS signature commits to. */
  readonly quantity?: number;
}

export interface ComposedPrescription {
  readonly draftId: string;
  readonly prescriberNpi: string;
  readonly medicationRef: string;
  readonly sig: string;
  readonly jurisdiction: string;
  readonly controlledSchedule: ControlledSchedule | null;
  readonly medicationList: typeof wp062MedicationListPlaceholder.fixtureId;
  /** Carried when the draft names it, so the transmitted payload is the signed content. */
  readonly patientRef?: string;
  /** Carried when the draft names it, so the transmitted payload is the signed content. */
  readonly quantity?: number;
}

export interface DirectoryEntry {
  readonly npi: string;
  readonly displayName: string;
}

export const directoryFixture: readonly DirectoryEntry[] = [
  { npi: '1234567893', displayName: 'Fixture Prescriber' },
  { npi: '1245319599', displayName: 'Second Fixture Prescriber' },
];

export type ComposerErrorCode =
  | 'EPCS_DENIED'
  | 'EPCS_REPLAY'
  | 'EPCS_WRONG_PRESCRIBER'
  | 'EPCS_UNKNOWN_CHALLENGE'
  | 'EPCS_CONTENT_MISMATCH'
  | 'DIRECTORY_MISS'
  | 'PDMP_REQUIRED'
  | 'INVALID_DRAFT'
  | 'JURISDICTION_BLOCKED';

export class ComposerError extends Error {
  public constructor(public readonly code: ComposerErrorCode) {
    super(code);
    this.name = 'ComposerError';
  }
}

export function lookupDirectory(npi: string): DirectoryEntry {
  const entry = directoryFixture.find((item) => item.npi === npi);
  if (entry === undefined) throw new ComposerError('DIRECTORY_MISS');
  return entry;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SCHEDULES: readonly string[] = ['II', 'III', 'IV', 'V'];

/**
 * The native-path validator: required fields, a known prescriber and a legal jurisdiction for
 * topic erx-epcs-pdmp. Throws the first problem it finds.
 */
export function validateDraft(
  draft: PrescriptionDraft,
  jurisdictions: ErxJurisdictionPort = fixtureJurisdictionPort(),
): void {
  if (
    !TOKEN.test(draft.draftId) ||
    !/^\d{10}$/.test(draft.prescriberNpi) ||
    draft.medicationRef.trim() === '' ||
    draft.sig.trim() === '' ||
    draft.jurisdiction.trim() === '' ||
    (draft.controlledSchedule != null && !SCHEDULES.includes(draft.controlledSchedule))
  ) {
    throw new ComposerError('INVALID_DRAFT');
  }
  lookupDirectory(draft.prescriberNpi);
  const decision = jurisdictions.resolve(draft.jurisdiction);
  if (
    decision.topic !== ERX_JURISDICTION_TOPIC ||
    !decision.resolved ||
    decision.obligations.includes(JURISDICTION_HARD_BLOCK)
  ) {
    throw new ComposerError('JURISDICTION_BLOCKED');
  }
}

/** The native composer: maps a validated draft to the outbound prescription payload. */
export function composePayload(draft: PrescriptionDraft): ComposedPrescription {
  lookupDirectory(draft.prescriberNpi);
  return {
    draftId: draft.draftId,
    prescriberNpi: draft.prescriberNpi,
    medicationRef: draft.medicationRef,
    sig: draft.sig,
    jurisdiction: draft.jurisdiction,
    controlledSchedule: draft.controlledSchedule ?? null,
    medicationList: wp062MedicationListPlaceholder.fixtureId,
    ...(draft.patientRef === undefined ? {} : { patientRef: draft.patientRef }),
    ...(draft.quantity === undefined ? {} : { quantity: draft.quantity }),
  };
}

// ---------------------------------------------------------------------------------------------
// EPCS two-factor signing. Module-local placeholder for the WP-028 erx/pdmp simulator.
// ---------------------------------------------------------------------------------------------

export interface EpcsChallenge {
  readonly challengeId: string;
  readonly prescriberNpi: string;
  readonly draftId: string;
  /** Canonical hash of the prescription content the prescriber is asked to sign. */
  readonly contentHash: string;
}

/**
 * Canonical SHA-256 of what a signature commits to: prescriber, patient, drug, sig, quantity,
 * schedule and jurisdiction (with the draft id). Any change to any of them changes the hash.
 */
export function prescriptionContentHash(draft: PrescriptionDraft): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        draft.draftId,
        draft.prescriberNpi,
        draft.patientRef ?? null,
        draft.medicationRef,
        draft.sig,
        draft.quantity ?? null,
        draft.controlledSchedule ?? null,
        draft.jurisdiction,
      ]),
    )
    .digest('hex');
}

/** The same canonical hash, taken over an outbound payload (what is actually transmitted). */
export function payloadContentHash(payload: ComposedPrescription): string {
  return prescriptionContentHash({
    draftId: payload.draftId,
    prescriberNpi: payload.prescriberNpi,
    medicationRef: payload.medicationRef,
    sig: payload.sig,
    jurisdiction: payload.jurisdiction,
    controlledSchedule: payload.controlledSchedule,
    ...(payload.patientRef === undefined ? {} : { patientRef: payload.patientRef }),
    ...(payload.quantity === undefined ? {} : { quantity: payload.quantity }),
  });
}

/**
 * The prescriber's second factor: a token device that answers a challenge with an HMAC code. Only
 * the prescriber who enrolled holds it; its secret is never exported.
 */
export interface EpcsDevice {
  readonly prescriberNpi: string;
  code(challenge: EpcsChallenge): string;
}

export interface SignedPrescription {
  readonly draftId: string;
  readonly prescriberNpi: string;
  readonly challengeId: string;
  readonly signedAt: string;
  /**
   * The challenged content hash the device code was computed over (it is inside the HMAC input),
   * so the signature attests to exactly this prescription content.
   */
  readonly contentHash: string;
}

function hmac(secret: Buffer, challenge: EpcsChallenge): string {
  return createHmac('sha256', secret)
    .update(
      `${challenge.challengeId}\u001f${challenge.prescriberNpi}\u001f${challenge.draftId}\u001f${challenge.contentHash}`,
    )
    .digest('hex');
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Stands for the WP-028 erx/pdmp simulator's EPCS service (R6-SR-050): per-prescription signing
 * with a knowledge factor and a device factor, a one-time challenge bound to the prescriber and the
 * draft, and a challenge that is consumed on success so a replay is refused.
 */
export class EpcsSimulator {
  private readonly prescribers = new Map<
    string,
    { readonly password: string; readonly secret: Buffer }
  >();
  private readonly challenges = new Map<
    string,
    { readonly challenge: EpcsChallenge; consumed: boolean }
  >();
  private seq = 0;

  /** Enrols a prescriber; returns the device only the prescriber holds. */
  public enroll(prescriberNpi: string, password: string): EpcsDevice {
    lookupDirectory(prescriberNpi);
    if (password.length < 8) throw new ComposerError('EPCS_DENIED');
    const secret = randomBytes(32);
    this.prescribers.set(prescriberNpi, { password, secret });
    return { prescriberNpi, code: (challenge) => hmac(secret, challenge) };
  }

  /**
   * Issues a one-time challenge for one prescription and one prescriber, committed to the exact
   * prescription content the prescriber is shown (`content`).
   */
  public issueChallenge(
    prescriberNpi: string,
    draftId: string,
    content: PrescriptionDraft,
  ): EpcsChallenge {
    if (!this.prescribers.has(prescriberNpi)) throw new ComposerError('EPCS_DENIED');
    if (content.prescriberNpi !== prescriberNpi || content.draftId !== draftId) {
      throw new ComposerError('EPCS_WRONG_PRESCRIBER');
    }
    this.seq += 1;
    const challenge: EpcsChallenge = Object.freeze({
      challengeId: `epcs-${String(this.seq)}-${randomBytes(6).toString('hex')}`,
      prescriberNpi,
      draftId,
      contentHash: prescriptionContentHash(content),
    });
    this.challenges.set(challenge.challengeId, { challenge, consumed: false });
    return challenge;
  }

  /**
   * Signs one prescription. The challenge must be unused and bound to this draft and to the
   * prescriber on the draft; both factors must belong to that prescriber. Success consumes it.
   */
  public sign(
    draft: PrescriptionDraft,
    input: {
      readonly challengeId: string;
      readonly password: string;
      readonly deviceCode: string;
      readonly at: string;
    },
  ): SignedPrescription {
    const held = this.challenges.get(input.challengeId);
    if (held === undefined) throw new ComposerError('EPCS_UNKNOWN_CHALLENGE');
    if (held.consumed) throw new ComposerError('EPCS_REPLAY');
    const { challenge } = held;
    if (challenge.prescriberNpi !== draft.prescriberNpi || challenge.draftId !== draft.draftId) {
      throw new ComposerError('EPCS_WRONG_PRESCRIBER');
    }
    if (prescriptionContentHash(draft) !== challenge.contentHash) {
      throw new ComposerError('EPCS_CONTENT_MISMATCH');
    }
    const enrolled = this.prescribers.get(challenge.prescriberNpi);
    if (
      enrolled === undefined ||
      !sameText(input.password, enrolled.password) ||
      !sameText(input.deviceCode, hmac(enrolled.secret, challenge))
    ) {
      throw new ComposerError('EPCS_DENIED');
    }
    held.consumed = true;
    return Object.freeze({
      draftId: draft.draftId,
      prescriberNpi: draft.prescriberNpi,
      challengeId: challenge.challengeId,
      signedAt: input.at,
      contentHash: challenge.contentHash,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// PDMP hook and the outbound rail.
// ---------------------------------------------------------------------------------------------

/** PDMP query hook; the WP-028 pdmp-sim binds here. */
export interface PdmpPort {
  check(draft: PrescriptionDraft): 'checked' | 'unavailable';
}

/** The native vendor transmit; a live rail would call it, shadow mode never does. */
export interface NativeTransmitPort {
  transmit(payload: ComposedPrescription, signature: SignedPrescription): void;
}

/** Sends through the transmit port in live mode; in shadow mode it only records the payload. */
export class NativeRail {
  private readonly shadowed: ComposedPrescription[] = [];

  public constructor(
    private readonly port: NativeTransmitPort,
    public readonly mode: 'shadow' | 'live',
  ) {}

  /**
   * On the transmit path (live mode), refuses (EPCS_CONTENT_MISMATCH) any payload that is not
   * exactly the content the signature attests to: same draft, same prescriber, same canonical
   * content hash. A payload altered between signing and transmit never reaches the port. Shadow
   * mode transmits nothing; it records the payload so the parity harness can report every field
   * mismatch.
   */
  public send(payload: ComposedPrescription, signature: SignedPrescription): void {
    if (this.mode === 'live') {
      if (
        signature.draftId !== payload.draftId ||
        signature.prescriberNpi !== payload.prescriberNpi ||
        typeof signature.contentHash !== 'string' ||
        !sameText(signature.contentHash, payloadContentHash(payload))
      ) {
        throw new ComposerError('EPCS_CONTENT_MISMATCH');
      }
      this.port.transmit(payload, signature);
      return;
    }
    this.shadowed.push(payload);
  }

  public shadowRecord(): readonly ComposedPrescription[] {
    return [...this.shadowed];
  }
}

// ---------------------------------------------------------------------------------------------
// Native-shadow parity harness.
// ---------------------------------------------------------------------------------------------

/** One corpus entry: a draft and the independently written outcome it must produce. */
export type ShadowCorpusEntry =
  | {
      readonly draft: PrescriptionDraft;
      readonly expect: 'composed';
      readonly payload: ComposedPrescription;
    }
  | {
      readonly draft: PrescriptionDraft;
      readonly expect: 'failed';
      readonly reason: ComposerErrorCode;
    };

export interface FieldMismatch {
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export type ShadowDraftResult =
  | {
      readonly draftId: string;
      readonly outcome: 'composed';
      readonly mismatches: readonly FieldMismatch[];
    }
  | {
      readonly draftId: string;
      readonly outcome: 'failed';
      readonly reason: ComposerErrorCode | 'UNEXPECTED';
    };

export interface ShadowReport {
  readonly results: readonly ShadowDraftResult[];
  /** Entries expected to compose. */
  readonly composable: number;
  /** Of those, how many composed with every field matching the reference. */
  readonly composedMatching: number;
  /** composedMatching / composable, 0..1. The gate is 1. */
  readonly composeRate: number;
  /** Entries whose outcome differs from the corpus expectation. */
  readonly outcomeMismatches: readonly string[];
  /** Calls the transmit port actually received. The gate is 0. */
  readonly transmitCalls: number;
  readonly pdmpChecks: number;
  readonly parity: boolean;
}

export interface ShadowDeps {
  /** Signs one draft with EPCS two-factor; throws a ComposerError when signing fails. */
  readonly sign: (draft: PrescriptionDraft) => SignedPrescription;
  readonly pdmp: PdmpPort;
  readonly transmit: NativeTransmitPort;
  readonly jurisdictions?: ErxJurisdictionPort;
  /** The native composer under test; injectable so a mutant can prove parity can fail. */
  readonly compose?: (draft: PrescriptionDraft) => ComposedPrescription;
  /** Rail mode; shadow unless a test proves the counter can see a live call. */
  readonly mode?: 'shadow' | 'live';
}

function compare(expected: ComposedPrescription, actual: ComposedPrescription): FieldMismatch[] {
  const fields = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  const out: FieldMismatch[] = [];
  for (const field of fields) {
    const want = (expected as unknown as Record<string, unknown>)[field];
    const got = (actual as unknown as Record<string, unknown>)[field];
    if (JSON.stringify(want) !== JSON.stringify(got))
      out.push({ field, expected: want, actual: got });
  }
  return out;
}

/**
 * Runs the native path (validate, PDMP for controlled drugs, EPCS sign, compose, send) over the
 * corpus in shadow mode. Each draft gets its own result; one failure never aborts the batch. The
 * payload is compared field by field with the corpus's hand-written reference, and transmits are
 * counted at the injected port.
 */
export function runNativeShadow(
  corpus: readonly ShadowCorpusEntry[],
  deps: ShadowDeps,
): ShadowReport {
  let transmitCalls = 0;
  const counting: NativeTransmitPort = {
    transmit: (payload, signature) => {
      transmitCalls += 1;
      deps.transmit.transmit(payload, signature);
    },
  };
  const rail = new NativeRail(counting, deps.mode ?? 'shadow');
  const compose = deps.compose ?? composePayload;
  const results: ShadowDraftResult[] = [];
  const outcomeMismatches: string[] = [];
  let pdmpChecks = 0;
  let composable = 0;
  let composedMatching = 0;

  for (const entry of corpus) {
    const { draft } = entry;
    if (entry.expect === 'composed') composable += 1;
    let result: ShadowDraftResult;
    try {
      validateDraft(draft, deps.jurisdictions);
      if (draft.controlledSchedule != null) {
        pdmpChecks += 1;
        if (deps.pdmp.check(draft) !== 'checked') throw new ComposerError('PDMP_REQUIRED');
      }
      const signature = deps.sign(draft);
      const payload = compose(draft);
      rail.send(payload, signature);
      const mismatches = entry.expect === 'composed' ? compare(entry.payload, payload) : [];
      result = { draftId: draft.draftId, outcome: 'composed', mismatches };
    } catch (error) {
      result = {
        draftId: draft.draftId,
        outcome: 'failed',
        reason: error instanceof ComposerError ? error.code : 'UNEXPECTED',
      };
    }
    results.push(result);
    if (entry.expect === 'composed') {
      if (result.outcome === 'composed' && result.mismatches.length === 0) composedMatching += 1;
      else outcomeMismatches.push(draft.draftId);
    } else if (result.outcome !== 'failed' || result.reason !== entry.reason) {
      outcomeMismatches.push(draft.draftId);
    }
  }

  const composeRate = composable === 0 ? 0 : composedMatching / composable;
  return {
    results,
    composable,
    composedMatching,
    composeRate,
    outcomeMismatches,
    transmitCalls,
    pdmpChecks,
    parity: composeRate === 1 && outcomeMismatches.length === 0 && transmitCalls === 0,
  };
}
