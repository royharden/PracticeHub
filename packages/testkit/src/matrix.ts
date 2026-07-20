import { parseCsv, records, serializeCsv } from './csv.js';
import { requiredFixtureClasses } from './fixtures.js';
import type { FixtureClass } from './fixtures.js';

/**
 * Persona×story matrix contract (see docs/contracts/persona-story-matrix.md).
 * ONE artifact — docs/requirements/persona-story-matrix.csv — derived
 * deterministically from the graduated corpus, feeding both the synthetic
 * generator and the acceptance harness. Every row carries the four-class
 * fixture floor.
 */

export const personaStoryMatrixHeader = [
  'canonical_id',
  'category',
  'persona',
  'persona_slug',
  'persona_class',
  'journey',
  'required_fixture_classes',
] as const;

export interface PersonaStoryRow {
  readonly canonicalId: string;
  readonly category: string;
  readonly persona: string;
  readonly personaSlug: string;
  readonly personaClass: string;
  readonly journey: string;
  readonly requiredFixtureClasses: readonly FixtureClass[];
}

export interface PersonaRegistryEntry {
  readonly slug: string;
  readonly name: string;
  readonly class: string;
}

const canonicalIdPattern = /^REQ-[A-Z]+-\d{3}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse docs/requirements/personas.json into the registry entries the matrix needs. */
export function parsePersonaRegistry(text: string): PersonaRegistryEntry[] {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || !Array.isArray(raw.personas)) {
    throw new Error('personas.json must be an object with a personas array');
  }
  return raw.personas.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.slug !== 'string' ||
      typeof entry.name !== 'string' ||
      typeof entry.class !== 'string'
    ) {
      throw new Error(`personas.json personas[${index}] lacks slug/name/class strings`);
    }
    return { slug: entry.slug, name: entry.name, class: entry.class };
  });
}

/**
 * Derive the matrix rows from the graduated canonical-requirements CSV and the
 * persona registry: one row per (canonical requirement × primary persona), in
 * corpus file order, personas in their listed order. An unregistered persona
 * name is a hard error — the registry is the only persona authority.
 */
export function buildPersonaStoryMatrix(
  canonicalRequirementsCsv: string,
  personaRegistry: readonly PersonaRegistryEntry[],
): PersonaStoryRow[] {
  const registryByName = new Map(personaRegistry.map((entry) => [entry.name, entry]));
  const rows: PersonaStoryRow[] = [];
  const errors: string[] = [];
  for (const requirement of records(parseCsv(canonicalRequirementsCsv))) {
    const canonicalId = requirement['id'] ?? '';
    if (!canonicalIdPattern.test(canonicalId)) {
      errors.push(`canonical-requirements row has malformed id "${canonicalId}"`);
      continue;
    }
    const personas = (requirement['personas_primary'] ?? '')
      .split(';')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (personas.length === 0) {
      errors.push(`${canonicalId} has no primary personas`);
      continue;
    }
    for (const persona of personas) {
      const entry = registryByName.get(persona);
      if (!entry) {
        errors.push(`${canonicalId} names persona "${persona}" absent from personas.json`);
        continue;
      }
      rows.push({
        canonicalId,
        category: requirement['category'] ?? '',
        persona: entry.name,
        personaSlug: entry.slug,
        personaClass: entry.class,
        journey: requirement['journey'] ?? '',
        requiredFixtureClasses: [...requiredFixtureClasses],
      });
    }
  }
  if (errors.length > 0) {
    throw new Error(`persona-story matrix derivation failed:\n- ${errors.join('\n- ')}`);
  }
  return rows;
}

export function serializePersonaStoryMatrix(rows: readonly PersonaStoryRow[]): string {
  return serializeCsv(
    personaStoryMatrixHeader,
    rows.map((row) => [
      row.canonicalId,
      row.category,
      row.persona,
      row.personaSlug,
      row.personaClass,
      row.journey,
      row.requiredFixtureClasses.join(';'),
    ]),
  );
}

/**
 * Parse a persona-story-matrix CSV and enforce its structural floor: exact
 * header, well-formed canonical ids, and every row listing at least the four
 * required fixture classes. Collects every violation before throwing.
 */
export function parsePersonaStoryMatrix(text: string): PersonaStoryRow[] {
  const parsed = parseCsv(text);
  const header = (parsed[0] ?? []).map((column) => column.replace(/^\uFEFF/, ''));
  const errors: string[] = [];
  if (header.join(',') !== personaStoryMatrixHeader.join(',')) {
    errors.push(
      `header mismatch: expected "${personaStoryMatrixHeader.join(',')}", found "${header.join(',')}"`,
    );
  }
  const rows: PersonaStoryRow[] = [];
  for (const [index, record] of records(parsed).entries()) {
    const line = index + 2;
    const canonicalId = record['canonical_id'] ?? '';
    if (!canonicalIdPattern.test(canonicalId)) {
      errors.push(`row ${line}: malformed canonical_id "${canonicalId}"`);
    }
    const classes = (record['required_fixture_classes'] ?? '')
      .split(';')
      .filter((value) => value.length > 0);
    const missing = requiredFixtureClasses.filter(
      (fixtureClass) => !classes.includes(fixtureClass),
    );
    if (missing.length > 0) {
      errors.push(
        `row ${line} (${canonicalId}) is below the fixture floor: missing ${missing.join(', ')}`,
      );
    }
    rows.push({
      canonicalId,
      category: record['category'] ?? '',
      persona: record['persona'] ?? '',
      personaSlug: record['persona_slug'] ?? '',
      personaClass: record['persona_class'] ?? '',
      journey: record['journey'] ?? '',
      requiredFixtureClasses: classes.filter((value): value is FixtureClass =>
        (requiredFixtureClasses as readonly string[]).includes(value),
      ),
    });
  }
  if (errors.length > 0) {
    throw new Error(`persona-story matrix invalid:\n- ${errors.join('\n- ')}`);
  }
  return rows;
}
