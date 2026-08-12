/**
 * Seed-set emitter (WP-029 `schema_effects: seed sets`).
 *
 * Renders the generated corpus as an idempotent Postgres seed over the WP-013
 * identity tables. Two properties the rest of the build depends on:
 *
 * - IDEMPOTENT. `pnpm local:seed` runs on both the up and the seed path and may
 *   run repeatedly; every statement is `ON CONFLICT ... DO UPDATE` or
 *   `DO NOTHING`, so a reseed converges rather than erroring or doubling.
 * - GENERATED, not hand-maintained. A drift test compares the committed file's
 *   marked section against a fresh emission, so the seed and the corpus cannot
 *   disagree — the WP-012/WP-020 generated-seed precedent.
 *
 * Only tables WP-013 owns are written, with ids under a `sg-` prefix that no
 * other seed uses, so the standing proofs seeded by WP-013..WP-026 (which are
 * keyed to their own ids) are untouched by corpus volume.
 */
import type { SynthCorpus } from './corpus.js';
import type { CorpusSubject } from './identity.js';

export const synthgenSeedBeginMarker = '-- synthgen:generated:begin';
export const synthgenSeedEndMarker = '-- synthgen:generated:end';

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqlOptional = (value: string | null): string => (value === null ? 'NULL' : sqlLiteral(value));

function personRows(corpus: SynthCorpus): string[] {
  const subjectById = new Map(corpus.subjects.map((subject) => [subject.subjectId, subject]));
  const rows = corpus.subjects.map(
    (subject) =>
      `  (${sqlLiteral(subject.tenantId)}, ${sqlLiteral(subject.subjectId)}, ` +
      `${sqlLiteral(subject.status)}, ` +
      `${sqlOptional(subject.status === 'verified' ? `synthetic-corpus-evidence:${subject.subjectId}` : null)}, ` +
      `${sqlLiteral(subject.birthDate)}::date, 'synthgen-v1', 'synthetic-corpus-loader', true)`,
  );
  for (const collision of corpus.collisions) {
    const twin = collision.legacyTwin;
    if (!twin) {
      continue;
    }
    const origin = subjectById.get(collision.leftSubjectId);
    if (!origin) {
      throw new Error(
        `emit: collision ${collision.collisionId} names an unknown subject ${collision.leftSubjectId}`,
      );
    }
    // The twin is deliberately PROVISIONAL and evidence-free: an acquired
    // record nobody has verified is exactly what arrives in a migration.
    rows.push(
      `  (${sqlLiteral(origin.tenantId)}, ${sqlLiteral(twin.personId)}, 'provisional', NULL, ` +
        `${sqlLiteral(origin.birthDate)}::date, 'synthgen-v1-acquired-clinic', ` +
        `'synthetic-corpus-loader', true)`,
    );
  }
  return rows;
}

function nameRows(corpus: SynthCorpus): string[] {
  const subjectById = new Map(corpus.subjects.map((subject) => [subject.subjectId, subject]));
  const rows: string[] = [];
  const push = (subject: CorpusSubject, personId: string): void => {
    rows.push(
      `  (${sqlLiteral(subject.tenantId)}, ${sqlLiteral(personId)}, 'legal', 1, ` +
        `${sqlLiteral(subject.legalName.givenName)}, ${sqlLiteral(subject.legalName.familyName)}, ` +
        `NULL, 'synthgen-v1', '{}', true)`,
    );
  };
  for (const subject of corpus.subjects) {
    push(subject, subject.subjectId);
    if (subject.affirmedName) {
      rows.push(
        `  (${sqlLiteral(subject.tenantId)}, ${sqlLiteral(subject.subjectId)}, 'affirmed', 1, ` +
          `${sqlLiteral(subject.affirmedName.givenName)}, ` +
          `${sqlLiteral(subject.affirmedName.familyName)}, NULL, 'synthgen-v1', ` +
          `'{payer,pharmacy,laboratory,legal-document}', true)`,
      );
    }
  }
  for (const collision of corpus.collisions) {
    const twin = collision.legacyTwin;
    if (!twin) {
      continue;
    }
    const origin = subjectById.get(collision.leftSubjectId);
    if (origin) {
      // Same legal name as its origin — that is what makes the pair a duplicate.
      push(origin, twin.personId);
    }
  }
  return rows;
}

function patientRecordRows(corpus: SynthCorpus): string[] {
  return corpus.subjects.map(
    (subject, index) =>
      `  (${sqlLiteral(subject.tenantId)}, ` +
      `${sqlLiteral(`sg-pr-${String(index + 1).padStart(4, '0')}`)}, ` +
      `${sqlLiteral(subject.subjectId)}, ${sqlLiteral(subject.legalEntityId)}, ` +
      `${sqlLiteral(subject.homeLocationId)}, 'active', true)`,
  );
}

function endpointRows(corpus: SynthCorpus): string[] {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const subject of corpus.subjects) {
    for (const endpoint of subject.endpoints) {
      if (seen.has(endpoint.endpointId)) {
        continue;
      }
      seen.add(endpoint.endpointId);
      rows.push(
        `  (${sqlLiteral(subject.tenantId)}, ${sqlLiteral(endpoint.endpointId)}, ` +
          `${sqlLiteral(endpoint.kind)}, ${sqlLiteral(endpoint.value)}, true)`,
      );
    }
  }
  return rows;
}

function associationRows(corpus: SynthCorpus): string[] {
  const rows: string[] = [];
  for (const subject of corpus.subjects) {
    for (const endpoint of subject.endpoints) {
      rows.push(
        `  (${sqlLiteral(subject.tenantId)}, ${sqlLiteral(endpoint.endpointId)}, ` +
          `${sqlLiteral(subject.subjectId)}, ${sqlLiteral(endpoint.relationship)}, ` +
          `${sqlLiteral(endpoint.verification)}, NULL, 'synthgen-v1', NULL, true)`,
      );
    }
  }
  return rows;
}

function sourceIdentifierRows(corpus: SynthCorpus): string[] {
  const subjectById = new Map(corpus.subjects.map((subject) => [subject.subjectId, subject]));
  const rows: string[] = [];
  corpus.subjects.forEach((subject, index) => {
    for (const identifier of subject.sourceIdentifiers) {
      rows.push(
        `  (${sqlLiteral(subject.tenantId)}, ${sqlLiteral(identifier.sourceSystem)}, ` +
          `${sqlLiteral(identifier.sourceValue)}, ${sqlLiteral(subject.subjectId)}, ` +
          `${sqlLiteral(`sg-pr-${String(index + 1).padStart(4, '0')}`)}, ` +
          `${sqlLiteral(identifier.verification)}, NULL, 'synthgen-v1', NULL, true)`,
      );
    }
  });
  for (const collision of corpus.collisions) {
    const twin = collision.legacyTwin;
    if (!twin) {
      continue;
    }
    const origin = subjectById.get(collision.leftSubjectId);
    if (!origin) {
      continue;
    }
    // The twin carries no patient record: an unmatched acquired identity.
    rows.push(
      `  (${sqlLiteral(origin.tenantId)}, ${sqlLiteral(twin.sourceSystem)}, ` +
        `${sqlLiteral(twin.sourceValue)}, ${sqlLiteral(twin.personId)}, NULL, ` +
        `'asserted', NULL, 'synthgen-v1-acquired-clinic', NULL, true)`,
    );
  }
  return rows;
}

function insertBlock(
  table: string,
  columns: readonly string[],
  rows: readonly string[],
  conflict: string,
): string {
  if (rows.length === 0) {
    return `-- ${table}: no rows in this corpus version`;
  }
  return [
    `INSERT INTO ${table}`,
    `  (${columns.join(', ')})`,
    'VALUES',
    rows.join(',\n'),
    conflict,
  ].join('\n');
}

/**
 * Emit the generated section. LF only; the caller writes bytes (a CRLF writer
 * fails the drift test on line endings alone — the WP-015/WP-020 lesson).
 */
export function renderSynthgenSeedSection(corpus: SynthCorpus): string {
  const twinCount = corpus.collisions.filter((collision) => collision.legacyTwin !== null).length;
  const lines = [
    synthgenSeedBeginMarker,
    `-- corpus ${corpus.corpus_version} / recovery epoch ${corpus.recovery_epoch}`,
    `-- generator ${corpus.generator.name} ${corpus.generator.version}, master seed ${corpus.master_seed}`,
    `-- ${String(corpus.households.length)} households, ${String(corpus.subjects.length)} subjects, ` +
      `${String(corpus.collisions.length)} known-truth collisions (${String(twinCount)} seeded twins)`,
    '',
    insertBlock(
      'identity.person',
      [
        'tenant_id',
        'person_id',
        'status',
        'verification_evidence_ref',
        'birth_date',
        'provenance_source',
        'captured_by',
        'synthetic',
      ],
      personRows(corpus),
      [
        'ON CONFLICT (tenant_id, person_id) DO UPDATE',
        'SET status = EXCLUDED.status,',
        '    verification_evidence_ref = EXCLUDED.verification_evidence_ref,',
        '    birth_date = EXCLUDED.birth_date,',
        '    provenance_source = EXCLUDED.provenance_source,',
        '    synthetic = EXCLUDED.synthetic;',
      ].join('\n'),
    ),
    '',
    insertBlock(
      'identity.person_name',
      [
        'tenant_id',
        'person_id',
        'name_kind',
        'revision',
        'given_name',
        'family_name',
        'effective_date',
        'source',
        'unsafe_contexts',
        'synthetic',
      ],
      nameRows(corpus),
      [
        'ON CONFLICT (tenant_id, person_id, name_kind, revision) DO UPDATE',
        'SET given_name = EXCLUDED.given_name,',
        '    family_name = EXCLUDED.family_name,',
        '    unsafe_contexts = EXCLUDED.unsafe_contexts,',
        '    synthetic = EXCLUDED.synthetic;',
      ].join('\n'),
    ),
    '',
    insertBlock(
      'identity.patient_record',
      [
        'tenant_id',
        'patient_record_id',
        'person_id',
        'legal_entity_id',
        'home_location_id',
        'status',
        'synthetic',
      ],
      patientRecordRows(corpus),
      [
        'ON CONFLICT (tenant_id, patient_record_id) DO UPDATE',
        'SET legal_entity_id = EXCLUDED.legal_entity_id,',
        '    home_location_id = EXCLUDED.home_location_id,',
        '    status = EXCLUDED.status,',
        '    synthetic = EXCLUDED.synthetic;',
      ].join('\n'),
    ),
    '',
    insertBlock(
      'identity.channel_endpoint',
      ['tenant_id', 'endpoint_id', 'kind', 'endpoint_value', 'synthetic'],
      endpointRows(corpus),
      [
        'ON CONFLICT (tenant_id, endpoint_id) DO UPDATE',
        'SET kind = EXCLUDED.kind,',
        '    endpoint_value = EXCLUDED.endpoint_value,',
        '    synthetic = EXCLUDED.synthetic;',
      ].join('\n'),
    ),
    '',
    insertBlock(
      'identity.endpoint_association',
      [
        'tenant_id',
        'endpoint_id',
        'person_id',
        'relationship',
        'verification',
        'evidence_ref',
        'source',
        'consent_ref',
        'synthetic',
      ],
      associationRows(corpus),
      [
        'ON CONFLICT (tenant_id, endpoint_id, person_id) DO UPDATE',
        'SET relationship = EXCLUDED.relationship,',
        '    verification = EXCLUDED.verification,',
        '    synthetic = EXCLUDED.synthetic;',
      ].join('\n'),
    ),
    '',
    insertBlock(
      'identity.source_identifier',
      [
        'tenant_id',
        'source_system',
        'source_value',
        'person_id',
        'patient_record_id',
        'verification',
        'evidence_ref',
        'provenance_source',
        'ingest_ref',
        'synthetic',
      ],
      sourceIdentifierRows(corpus),
      [
        'ON CONFLICT (tenant_id, source_system, source_value) DO UPDATE',
        'SET person_id = EXCLUDED.person_id,',
        '    patient_record_id = EXCLUDED.patient_record_id,',
        '    provenance_source = EXCLUDED.provenance_source,',
        '    synthetic = EXCLUDED.synthetic;',
      ].join('\n'),
    ),
    '',
    synthgenSeedEndMarker,
  ];
  return lines.join('\n');
}
