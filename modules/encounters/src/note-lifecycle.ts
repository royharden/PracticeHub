import type {
  AthenaAttestation,
  ClinicalScope,
  NoteState,
  SoapBody,
} from './clinical-contracts.double.js';

export type NoteEvent =
  | { readonly kind: 'opened'; readonly noteId: string }
  | { readonly kind: 'copy-forward'; readonly fromNoteId: string; readonly noteId: string }
  | { readonly kind: 'approved-for-transmission'; readonly reviewerRef: string }
  | { readonly kind: 'attested'; readonly attestation: AthenaAttestation }
  | { readonly kind: 'amended'; readonly reason: string; readonly supersedesNoteId: string }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'reconciliation-task'; readonly taskId: string };

export class EncounterNoteError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EncounterNoteError';
  }
}

export interface EncounterNote {
  readonly scope: ClinicalScope;
  readonly soap: SoapBody;
  readonly state: NoteState;
  readonly authorRef: string;
  readonly version: number;
  readonly signedBaseVersion: number | null;
  readonly attestation: AthenaAttestation | null;
  readonly copyForwardFrom: string | null;
  readonly amendmentReason: string | null;
  readonly events: readonly NoteEvent[];
  readonly reconciliationTaskId: string | null;
}

function sameScope(
  a: ClinicalScope,
  b: Pick<ClinicalScope, 'tenantId' | 'personId' | 'encounterId'>,
): boolean {
  return a.tenantId === b.tenantId && a.personId === b.personId && a.encounterId === b.encounterId;
}

/**
 * Simulated encounter-note lifecycle. PracticeHub approval never signs.
 * Signature requires exact assigned-clinician Athena attestation.
 */
export class EncounterNoteService {
  private readonly notes = new Map<string, EncounterNote>();
  private seq = 0;

  public openDraft(scope: ClinicalScope, soap: SoapBody, authorRef: string): EncounterNote {
    this.refuseEmpty(soap);
    const note: EncounterNote = {
      scope,
      soap,
      state: 'proposal-draft',
      authorRef,
      version: 1,
      signedBaseVersion: null,
      attestation: null,
      copyForwardFrom: null,
      amendmentReason: null,
      events: [{ kind: 'opened', noteId: scope.noteId }],
      reconciliationTaskId: null,
    };
    this.notes.set(scope.noteId, note);
    return note;
  }

  public copyForward(fromNoteId: string, next: ClinicalScope, authorRef: string): EncounterNote {
    const source = this.require(fromNoteId);
    if (source.state !== 'signed-in-authority') {
      throw new EncounterNoteError('copy-forward requires a signed source note');
    }
    if (source.scope.tenantId !== next.tenantId || source.scope.personId !== next.personId) {
      throw new EncounterNoteError('copy-forward blocked: wrong patient');
    }
    if (source.scope.encounterId === next.encounterId) {
      throw new EncounterNoteError('copy-forward blocked: same encounter');
    }
    const note = this.openDraft(next, source.soap, authorRef);
    const copied: EncounterNote = {
      ...note,
      copyForwardFrom: fromNoteId,
      events: [...note.events, { kind: 'copy-forward', fromNoteId, noteId: next.noteId }],
    };
    this.notes.set(next.noteId, copied);
    return copied;
  }

  public approveForTransmission(noteId: string, reviewerRef: string): EncounterNote {
    const note = this.require(noteId);
    if (note.state !== 'proposal-draft' && note.state !== 'amendment-pending') {
      throw new EncounterNoteError(
        'only a draft or pending amendment can be approved for transmission',
      );
    }
    const next: EncounterNote = {
      ...note,
      state: 'approved-for-transmission',
      events: [...note.events, { kind: 'approved-for-transmission', reviewerRef }],
    };
    this.notes.set(noteId, next);
    return next;
  }

  public attest(
    noteId: string,
    expected: Pick<ClinicalScope, 'tenantId' | 'personId' | 'encounterId'>,
    assignedClinicianRef: string,
    evidence: AthenaAttestation | null,
  ): EncounterNote {
    const note = this.require(noteId);
    if (!sameScope(note.scope, expected)) {
      throw new EncounterNoteError('attestation blocked: wrong patient or encounter');
    }
    if (note.state !== 'approved-for-transmission') {
      throw new EncounterNoteError('attestation requires approved-for-transmission');
    }
    if (evidence === null) {
      const taskId = `recon-${++this.seq}`;
      const failed: EncounterNote = {
        ...note,
        state: 'proposal-draft',
        attestation: null,
        reconciliationTaskId: taskId,
        events: [...note.events, { kind: 'reconciliation-task', taskId }],
      };
      this.notes.set(noteId, failed);
      return failed;
    }
    if (evidence.assignedSignerRef !== assignedClinicianRef) {
      throw new EncounterNoteError('attestation blocked: signer is not the assigned clinician');
    }
    const next: EncounterNote = {
      ...note,
      state: 'signed-in-authority',
      attestation: evidence,
      signedBaseVersion: note.version,
      reconciliationTaskId: null,
      events: [...note.events, { kind: 'attested', attestation: evidence }],
    };
    this.notes.set(noteId, next);
    return next;
  }

  public amend(noteId: string, reason: string, soap: SoapBody, authorRef: string): EncounterNote {
    const signed = this.require(noteId);
    this.refuseEmpty(soap);
    if (signed.state !== 'signed-in-authority') {
      throw new EncounterNoteError('amendment requires a signed base');
    }
    if (reason.trim() === '') {
      throw new EncounterNoteError('amendment requires a reason');
    }
    const amendmentNoteId = `${noteId}#amend-${signed.version + 1}`;
    if (this.notes.has(amendmentNoteId)) {
      throw new EncounterNoteError(`amendment ${amendmentNoteId} already exists`);
    }
    const addendum: EncounterNote = {
      scope: { ...signed.scope, noteId: amendmentNoteId },
      soap,
      state: 'amendment-pending',
      authorRef,
      version: signed.version + 1,
      signedBaseVersion: signed.version,
      attestation: null,
      copyForwardFrom: null,
      amendmentReason: reason,
      events: [{ kind: 'amended', reason, supersedesNoteId: noteId }],
      reconciliationTaskId: null,
    };
    this.notes.set(amendmentNoteId, addendum);
    return addendum;
  }

  public get(noteId: string): EncounterNote {
    return this.require(noteId);
  }

  private require(noteId: string): EncounterNote {
    const note = this.notes.get(noteId);
    if (note === undefined) {
      throw new EncounterNoteError(`unknown note ${noteId}`);
    }
    return note;
  }

  private refuseEmpty(soap: SoapBody): void {
    if (
      soap.subjective.trim() === '' ||
      soap.objective.trim() === '' ||
      soap.assessment.trim() === '' ||
      soap.plan.trim() === ''
    ) {
      throw new EncounterNoteError('SOAP sections are required');
    }
  }
}
