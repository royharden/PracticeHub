import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RosterEnrollment } from './roster-enrollment.js';
import { acceptWrongPersonReport, UnattributedReportError } from './unattributed-report.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

function load(name: string): { requirementId: string; class: string } {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8')) as {
    requirementId: string;
    class: string;
  };
}

describe('REQ-ID-022 rehearsals', () => {
  it('loads the four-class fixture pack', () => {
    expect(load('REQ-ID-022.HAPPY.json').class).toBe('HAPPY');
    expect(load('REQ-ID-022.BOUNDARY.json').class).toBe('BOUNDARY');
    expect(load('REQ-ID-022.FAILURE.json').class).toBe('FAILURE');
    expect(load('REQ-ID-022.RECOVERY.json').class).toBe('RECOVERY');
  });

  it('activates only after independent verify and consent', () => {
    const roster = new RosterEnrollment();
    roster.upload({
      tenantId: 'northwind-synthetic',
      legalEntityId: 'entity-a',
      employeeRef: 'emp-1',
      employerContact: 'employer@example.test',
    });
    const invited = roster.get('emp-1');
    expect(invited.status).toBe('invited');
    expect(invited.identityVerified).toBe(false);
    const active = roster.verifyAndConsent('emp-1', 'self@example.test');
    expect(active.status).toBe('active');
    expect(active.identityVerified).toBe(true);
    expect(active.consentCompleted).toBe(true);
    expect(active.contactPref).toBe('self@example.test');
  });

  it('hides decline reason from the employer view', () => {
    const roster = new RosterEnrollment();
    roster.upload({
      tenantId: 'northwind-synthetic',
      legalEntityId: 'entity-a',
      employeeRef: 'emp-1',
      employerContact: 'employer@example.test',
    });
    roster.decline('emp-1', 'not interested');
    expect(roster.get('emp-1').declineReason).toBe('not interested');
    expect(roster.employerSees('emp-1')).toEqual({
      employerView: 'declined',
      declineReason: null,
      contactPref: null,
    });
  });

  it('lets the employee self-correct contact without employer resubmit', () => {
    const roster = new RosterEnrollment();
    roster.upload({
      tenantId: 'northwind-synthetic',
      legalEntityId: 'entity-a',
      employeeRef: 'emp-1',
      employerContact: 'wrong@example.test',
    });
    roster.verifyAndConsent('emp-1', 'wrong@example.test');
    const corrected = roster.selfCorrectContact('emp-1', 'right@example.test');
    expect(corrected.contactPref).toBe('right@example.test');
  });

  it('keeps the personal account after roster removal', () => {
    const roster = new RosterEnrollment();
    roster.upload({
      tenantId: 'northwind-synthetic',
      legalEntityId: 'entity-a',
      employeeRef: 'emp-1',
      employerContact: 'employer@example.test',
    });
    roster.verifyAndConsent('emp-1', 'self@example.test');
    const removed = roster.removeFromRoster('emp-1');
    expect(removed.status).toBe('roster-removed');
    expect(removed.consentCompleted).toBe(true);
    expect(removed.contactPref).toBe('self@example.test');
  });
});

describe('REQ-ID-017 NR-024 unattributed report rehearsal', () => {
  it('loads the extra FAILURE fixture without touching identity packs', () => {
    expect(load('REQ-ID-017.UNATTRIBUTED.FAILURE.json').requirementId).toBe('REQ-ID-017');
  });

  it('refuses an unattributed report and accepts an attributed one', () => {
    expect(() =>
      acceptWrongPersonReport({
        tenantId: 'northwind-synthetic',
        endpointId: 'nce-rivera-email',
        disputedPersonId: 'np-casey-rivera',
        reportedBy: null,
      }),
    ).toThrow(UnattributedReportError);
    expect(
      acceptWrongPersonReport({
        tenantId: 'northwind-synthetic',
        endpointId: 'nce-rivera-email',
        disputedPersonId: 'np-casey-rivera',
        reportedBy: 'synthetic-staff-001',
      }).suppressed,
    ).toEqual(['np-casey-rivera']);
  });
});
