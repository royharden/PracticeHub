import { describe, expect, it } from 'vitest';
import type { PersonaStoryRow } from '@practicehub/testkit';

import { evaluatePersonaStoryCoverage, personaStoryCoverageErrors } from './coverage.js';

function row(overrides: Partial<PersonaStoryRow> = {}): PersonaStoryRow {
  return {
    canonicalId: 'REQ-MIG-005',
    category: 'migration',
    persona: 'data-migration engineer',
    personaSlug: 'data-migration-engineer',
    personaClass: 'staff',
    journey: 'clinic-acquisition-onboarding',
    requiredFixtureClasses: ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'],
    ...overrides,
  };
}

const covering = [
  {
    subjectId: 'sg-p-0001',
    personaSlug: 'data-migration-engineer',
    journeys: ['clinic-acquisition-onboarding'],
  },
];

describe('evaluatePersonaStoryCoverage', () => {
  it('passes when every named persona and journey is played by a subject', () => {
    const report = evaluatePersonaStoryCoverage([row()], covering);
    expect(personaStoryCoverageErrors(report)).toEqual([]);
    expect(report.missingPersonaSlugs).toEqual([]);
    expect(report.missingJourneys).toEqual([]);
  });

  it('NAMES the persona nobody plays rather than reporting a count', () => {
    const rows = [row(), row({ personaSlug: 'prospective-patient', journey: 'acquisition' })];
    const report = evaluatePersonaStoryCoverage(rows, covering);
    expect(report.missingPersonaSlugs).toEqual(['prospective-patient']);
    const errors = personaStoryCoverageErrors(report);
    expect(errors.some((message) => message.includes('"prospective-patient"'))).toBe(true);
  });

  it('NAMES the journey nobody carries', () => {
    const rows = [row(), row({ journey: 'glp1-epcs-journey' })];
    const report = evaluatePersonaStoryCoverage(rows, covering);
    expect(report.missingJourneys).toEqual(['glp1-epcs-journey']);
    expect(
      personaStoryCoverageErrors(report).some((message) => message.includes('"glp1-epcs-journey"')),
    ).toBe(true);
  });

  it('an empty corpus fails every persona — the floor is not vacuous', () => {
    const report = evaluatePersonaStoryCoverage([row()], []);
    expect(report.subjectCount).toBe(0);
    // Both the persona and its journey go uncovered, and both are named.
    const errors = personaStoryCoverageErrors(report);
    expect(errors).toHaveLength(2);
    expect(errors.some((message) => message.includes('"data-migration-engineer"'))).toBe(true);
    expect(errors.some((message) => message.includes('"clinic-acquisition-onboarding"'))).toBe(
      true,
    );
  });

  it('rows with an empty journey contribute no journey requirement', () => {
    const report = evaluatePersonaStoryCoverage(
      [row({ journey: '' })],
      [{ subjectId: 'sg-p-0001', personaSlug: 'data-migration-engineer', journeys: [] }],
    );
    expect(report.requiredJourneys).toEqual([]);
    expect(personaStoryCoverageErrors(report)).toEqual([]);
  });

  it('catches a row whose fixture floor was LOWERED (the contract permits raising only)', () => {
    const lowered = row({ requiredFixtureClasses: ['HAPPY', 'BOUNDARY', 'FAILURE'] });
    const report = evaluatePersonaStoryCoverage([lowered], covering);
    expect(report.rowsBelowFloor).toHaveLength(1);
    expect(report.rowsBelowFloor[0]).toContain('missing RECOVERY');
  });

  it('permits a RAISED floor', () => {
    const raised = row({
      requiredFixtureClasses: ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY', 'BOUNDARY'],
    });
    const report = evaluatePersonaStoryCoverage([raised], covering);
    expect(report.rowsBelowFloor).toEqual([]);
  });

  it('reports required and covered sets sorted and deduplicated', () => {
    const rows = [row(), row(), row({ personaSlug: 'a-persona', journey: 'a-journey' })];
    const report = evaluatePersonaStoryCoverage(rows, covering);
    expect(report.requiredPersonaSlugs).toEqual(['a-persona', 'data-migration-engineer']);
    expect(report.requiredJourneys).toEqual(['a-journey', 'clinic-acquisition-onboarding']);
  });
});
