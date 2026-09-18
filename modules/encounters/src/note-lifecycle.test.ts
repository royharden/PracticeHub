import { describe, expect, it } from 'vitest';

import type { AthenaAttestation, ClinicalScope, SoapBody } from './clinical-contracts.double.js';
import { EncounterNoteError, EncounterNoteService } from './note-lifecycle.js';

const soap: SoapBody = {
  subjective: 'fatigue',
  objective: 'hr 72',
  assessment: 'stable',
  plan: 'follow-up',
};

function scope(noteId: string, encounterId = 'enc-1'): ClinicalScope {
  return {
    tenantId: 'northwind-synthetic',
    personId: 'person-1',
    encounterId,
    noteId,
  };
}

const evidence: AthenaAttestation = {
  assignedSignerRef: 'clinician-assigned',
  sourceVersion: 'athena-sv-1',
  signedAt: '2026-06-01T09:00:00Z',
  attestationRef: 'att-1',
  synthetic: true,
};

describe('EncounterNoteService', () => {
  it('keeps application approval unsigned until assigned-clinician attestation', () => {
    const svc = new EncounterNoteService();
    svc.openDraft(scope('note-1'), soap, 'author-1');
    const approved = svc.approveForTransmission('note-1', 'reviewer-1');
    expect(approved.state).toBe('approved-for-transmission');
    expect(approved.attestation).toBeNull();
    const signed = svc.attest('note-1', scope('note-1'), 'clinician-assigned', evidence);
    expect(signed.state).toBe('signed-in-authority');
    expect(signed.attestation?.assignedSignerRef).toBe('clinician-assigned');
    expect(signed.signedBaseVersion).toBe(1);
  });

  it('refuses a non-assigned signer', () => {
    const svc = new EncounterNoteService();
    svc.openDraft(scope('note-1'), soap, 'author-1');
    svc.approveForTransmission('note-1', 'reviewer-1');
    expect(() =>
      svc.attest('note-1', scope('note-1'), 'clinician-assigned', {
        ...evidence,
        assignedSignerRef: 'other',
      }),
    ).toThrow(EncounterNoteError);
  });

  it('copy-forwards SOAP into a new unsigned draft on a later encounter', () => {
    const svc = new EncounterNoteService();
    svc.openDraft(scope('note-1'), soap, 'author-1');
    svc.approveForTransmission('note-1', 'reviewer-1');
    svc.attest('note-1', scope('note-1'), 'clinician-assigned', evidence);
    const copied = svc.copyForward('note-1', scope('note-2', 'enc-2'), 'author-2');
    expect(copied.state).toBe('proposal-draft');
    expect(copied.soap).toEqual(soap);
    expect(copied.copyForwardFrom).toBe('note-1');
    expect(copied.attestation).toBeNull();
  });

  it('amendment is a new unsigned addendum and leaves the signed SOAP unmutated', () => {
    const svc = new EncounterNoteService();
    svc.openDraft(scope('note-1'), soap, 'author-1');
    svc.approveForTransmission('note-1', 'reviewer-1');
    svc.attest('note-1', scope('note-1'), 'clinician-assigned', evidence);
    expect(() => svc.amend('note-1', ' ', { ...soap, plan: 'labs' }, 'author-1')).toThrow(/reason/);
    const amended = svc.amend('note-1', 'add labs', { ...soap, plan: 'labs' }, 'author-1');
    const signed = svc.get('note-1');
    expect(signed.state).toBe('signed-in-authority');
    expect(signed.soap).toEqual(soap);
    expect(signed.attestation?.attestationRef).toBe('att-1');
    expect(signed.version).toBe(1);
    expect(amended.scope.noteId).toBe('note-1#amend-2');
    expect(amended.state).toBe('amendment-pending');
    expect(amended.signedBaseVersion).toBe(1);
    expect(amended.version).toBe(2);
    expect(amended.attestation).toBeNull();
    expect(amended.soap.plan).toBe('labs');
    expect(amended.events).toContainEqual({
      kind: 'amended',
      reason: 'add labs',
      supersedesNoteId: 'note-1',
    });
  });

  it('wrong patient or encounter fails closed before attestation', () => {
    const svc = new EncounterNoteService();
    svc.openDraft(scope('note-1'), soap, 'author-1');
    svc.approveForTransmission('note-1', 'reviewer-1');
    expect(() =>
      svc.attest(
        'note-1',
        { tenantId: 'northwind-synthetic', personId: 'person-other', encounterId: 'enc-1' },
        'clinician-assigned',
        evidence,
      ),
    ).toThrow(/wrong patient or encounter/);
  });

  it('missing attestation leaves the note unsigned and opens one reconciliation task', () => {
    const svc = new EncounterNoteService();
    svc.openDraft(scope('note-1'), soap, 'author-1');
    svc.approveForTransmission('note-1', 'reviewer-1');
    const failed = svc.attest('note-1', scope('note-1'), 'clinician-assigned', null);
    expect(failed.state).toBe('proposal-draft');
    expect(failed.attestation).toBeNull();
    expect(failed.reconciliationTaskId).toMatch(/^recon-/);
  });
});
