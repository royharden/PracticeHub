/**
 * Credential + access anomaly unit suite (WP-017, REQ-ID-002 / REQ-ADM-019).
 * Session heuristics emit WP-014 AtoSignals that DRIVE the real
 * `raiseAtoLockdown` (FWD-AUTH-017-ANOMALY); snooping opens a forensic
 * investigation with the signals recorded verbatim.
 */
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import { raiseAtoLockdown, type AtoSignal } from './ato.js';
import type { AuthSession } from './authn.js';
import {
  detectSessionAnomalies,
  detectSnooping,
  openAccessAnomalyInvestigation,
  remediateAnomaly,
  type AccessSighting,
  type SessionSighting,
} from './credential-anomaly.js';
import type { EndpointAssociation } from './endpoints.js';

const tenant = 'northwind-synthetic' as TenantId;
const person = 'np-alex-rivera' as PersonId;
const staffPerson = 'np-morgan-lee' as PersonId;

function sighting(overrides: Partial<SessionSighting>): SessionSighting {
  return {
    sessionId: 'nse-1',
    deviceId: 'nde-1',
    locationRef: 'us-west',
    observedAt: '2026-03-25T10:00:00Z',
    ...overrides,
  };
}

describe('detectSessionAnomalies (REQ-ID-002 → AtoSignal[])', () => {
  it('raises a concurrent-session (new-device-burst) signal at the device threshold', () => {
    const signals = detectSessionAnomalies([
      sighting({ deviceId: 'nde-1' }),
      sighting({ deviceId: 'nde-2' }),
      sighting({ deviceId: 'nde-3' }),
    ]);
    expect(signals.map((s) => s.kind)).toContain('new-device-burst');
  });

  it('raises a credential-sharing (credential-stuffing) signal at the distinct-location threshold', () => {
    const signals = detectSessionAnomalies([
      sighting({ locationRef: 'us-west' }),
      sighting({ locationRef: 'eu-central', deviceId: 'nde-2' }),
    ]);
    expect(signals.map((s) => s.kind)).toContain('credential-stuffing');
  });

  it('raises impossible-travel for two locations within five minutes', () => {
    const signals = detectSessionAnomalies([
      sighting({ locationRef: 'us-west', observedAt: '2026-03-25T10:00:00Z' }),
      sighting({ locationRef: 'ap-south', deviceId: 'nde-2', observedAt: '2026-03-25T10:03:00Z' }),
    ]);
    expect(signals.map((s) => s.kind)).toContain('impossible-travel');
  });

  it('returns no signals for a single quiet sighting', () => {
    expect(detectSessionAnomalies([sighting({})])).toEqual([]);
  });

  it('the emitted signals DRIVE raiseAtoLockdown — the detection→containment handoff', () => {
    const signals: readonly AtoSignal[] = detectSessionAnomalies([
      sighting({ locationRef: 'us-west', observedAt: '2026-03-25T10:00:00Z' }),
      sighting({ locationRef: 'ap-south', deviceId: 'nde-2', observedAt: '2026-03-25T10:02:00Z' }),
    ]);
    expect(signals.length).toBeGreaterThan(0);
    const activeSession: AuthSession = {
      sessionId: 'nse-portal-1',
      tenantId: tenant,
      personId: person,
      principal: 'portal',
      deviceId: 'nde-1',
      assurance: 'aal1',
      status: 'active',
      createdAt: '2026-03-25T09:00:00Z',
      lastActivityAt: '2026-03-25T10:00:00Z',
      synthetic: true,
    };
    const association: EndpointAssociation = {
      tenantId: tenant,
      endpointId: 'nce-alex-email',
      personId: person,
      relationship: 'self',
      verification: 'verified',
      evidenceRef: 'synthetic-endpoint-evidence-0001',
      source: 'synthetic-intake',
      synthetic: true,
    };
    const result = raiseAtoLockdown(
      'nld-anomaly-0001',
      tenant,
      person,
      signals,
      [activeSession],
      [association],
      [],
      true,
    );
    // The detected signals are recorded verbatim on the lockdown (forensic) and
    // the active session is revoked.
    expect(result.lockdown.signals).toEqual(signals);
    expect(result.sessions[0]?.status).toBe('revoked');
  });
});

function accessSighting(overrides: Partial<AccessSighting>): AccessSighting {
  return {
    accessRef: 'access-1',
    subjectPersonId: person,
    segment: 'clinical-notes',
    hadTreatmentRelationship: true,
    withinAssignment: true,
    observedAt: '2026-03-25T10:00:00Z',
    ...overrides,
  };
}

describe('detectSnooping (REQ-ADM-019)', () => {
  it('flags an access with NEITHER a treatment relationship NOR an assignment basis', () => {
    const findings = detectSnooping([
      accessSighting({ hadTreatmentRelationship: true, withinAssignment: false }),
      accessSighting({
        accessRef: 'access-2',
        hadTreatmentRelationship: false,
        withinAssignment: false,
      }),
      accessSighting({
        accessRef: 'access-3',
        hadTreatmentRelationship: false,
        withinAssignment: true,
      }),
    ]);
    expect(findings.map((f) => f.accessRef)).toEqual(['access-2']);
  });
});

describe('openAccessAnomalyInvestigation (REQ-ID-002 / REQ-ADM-019)', () => {
  const request = {
    tenantId: tenant,
    anomalyId: 'anom-0001',
    pattern: 'snooping-access' as const,
    subjectStaffPersonId: staffPerson,
    signals: [
      {
        signalRef: 'sig-1',
        detail: 'access:access-2:clinical-notes',
        observedAt: '2026-03-25T10:00:00Z',
      },
    ],
    detectedAt: '2026-03-25T11:00:00Z',
    openedBy: 'synthetic-it-admin-001',
  };

  it('records the triggering signals verbatim and opens an investigation WorkItem', () => {
    const outcome = openAccessAnomalyInvestigation(request);
    expect(outcome.case.status).toBe('open');
    expect(outcome.case.signals).toEqual(request.signals);
    expect(outcome.investigationWorkItem.origin).toBe('authority-review');
    expect(outcome.investigationWorkItem.purpose).toBe('access-anomaly-investigation');
  });

  it('marks the case contained when a containment directive is supplied', () => {
    const outcome = openAccessAnomalyInvestigation({
      ...request,
      containmentRef: 'synthetic-rate-limit-0001',
    });
    expect(outcome.case.status).toBe('contained');
    expect(outcome.case.containmentRef).toBe('synthetic-rate-limit-0001');
  });

  it('fails closed on an empty signal set (the forensic record cannot be empty)', () => {
    expect(() => openAccessAnomalyInvestigation({ ...request, signals: [] })).toThrow(
      /forensic record fails closed/,
    );
  });

  it('resolves an investigation with disposition, evidence, and attribution (fail-closed)', () => {
    const opened = openAccessAnomalyInvestigation(request);
    const resolved = remediateAnomaly(opened.case, {
      disposition: 'confirmed-violation',
      remediationEvidenceRef: 'synthetic-remediation-evidence-0001',
      resolvedBy: 'synthetic-compliance-officer-001',
      occurredAt: '2026-03-26T09:00:00Z',
    });
    expect(resolved.case.status).toBe('remediated');
    expect(resolved.case.disposition).toBe('confirmed-violation');
    // The forensic signals are carried forward verbatim — never rewritten.
    expect(resolved.case.signals).toEqual(request.signals);
  });

  it('a no-violation disposition clears the case as a false positive', () => {
    const opened = openAccessAnomalyInvestigation(request);
    const resolved = remediateAnomaly(opened.case, {
      disposition: 'no-violation',
      remediationEvidenceRef: 'synthetic-remediation-evidence-0002',
      resolvedBy: 'synthetic-compliance-officer-001',
      occurredAt: '2026-03-26T09:00:00Z',
    });
    expect(resolved.case.status).toBe('false-positive');
  });
});
