/**
 * Vendor-sim gate (WP-027; ADR-003/ADR-014). PUBLIC step — everything it reads
 * is platform code, so a public clone runs it exactly as the development
 * machine does.
 *
 * Three things the WP-027 gate names:
 *   1. the injection-primitive catalog is complete and well-formed (eighteen
 *      unique, contiguous `X-##` ids drawn from the declared vocabularies), and
 *      every declared rail is a complete declaration bound to an `AUTH-###`
 *      authority with distinct scenario ordinals and catalog-known primitives;
 *   2. "PHI scan of sim stores", STATICALLY: the two persisted sim shapes
 *      (`SimEffectRecord`, `SimReceipt`) may not carry a field that could hold a
 *      value rather than a reference — a risky field name is admissible only as
 *      a `...Hash` or `...Ref`;
 *   3. "PHI scan of sim stores", DYNAMICALLY: a request whose payload carries
 *      identifiers is driven through every rail, and the resulting ledger dump
 *      is scanned for those values. Structure is asserted AND exercised.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  injectionOutcomeClasses,
  injectionPrimitiveFamilies,
  injectionPrimitiveIdPattern,
  injectionPrimitivesV1,
  InMemorySimStateStore,
  VendorSimEngine,
} from '@practicehub/vendor-sim-kit';
import { authorityIdPattern, railIdPattern } from '@practicehub/platform-integration';
import { railSimsV1 } from '@practicehub/vendor-simulator';

import { failIfAny, repoRoot } from './common.js';

const errors: string[] = [];

// (1) The catalog.
if (injectionPrimitivesV1.length !== 18) {
  errors.push(
    `the injection-primitive catalog declares ${injectionPrimitivesV1.length} primitives; the gate names X-01..X-18`,
  );
}
const seenPrimitiveIds = new Set<string>();
for (const [index, primitive] of injectionPrimitivesV1.entries()) {
  const expectedId = `X-${String(index + 1).padStart(2, '0')}`;
  if (primitive.primitiveId !== expectedId) {
    errors.push(
      `primitive ${index}: id ${JSON.stringify(primitive.primitiveId)} breaks the contiguous X-## order (expected ${expectedId})`,
    );
  }
  if (!injectionPrimitiveIdPattern.test(primitive.primitiveId)) {
    errors.push(`primitive ${primitive.primitiveId} is not an X-## id`);
  }
  if (seenPrimitiveIds.has(primitive.primitiveId)) {
    errors.push(`primitive ${primitive.primitiveId} is declared twice`);
  }
  seenPrimitiveIds.add(primitive.primitiveId);
  if (!(injectionPrimitiveFamilies as readonly string[]).includes(primitive.family)) {
    errors.push(`primitive ${primitive.primitiveId}: unknown family ${primitive.family}`);
  }
  if (!(injectionOutcomeClasses as readonly string[]).includes(primitive.outcomeClass)) {
    errors.push(
      `primitive ${primitive.primitiveId}: unknown outcome class ${primitive.outcomeClass}`,
    );
  }
  if (primitive.description.trim() === '' || primitive.name.trim() === '') {
    errors.push(`primitive ${primitive.primitiveId}: name and description must be present`);
  }
}

// (1b) The rails.
const seenRailIds = new Set<string>();
for (const rail of railSimsV1) {
  if (!railIdPattern.test(rail.railId)) {
    errors.push(`rail ${JSON.stringify(rail.railId)} is not a RAIL-### id`);
  }
  if (seenRailIds.has(rail.railId)) {
    errors.push(`rail ${rail.railId} is declared twice`);
  }
  seenRailIds.add(rail.railId);
  if (!authorityIdPattern.test(rail.authorityId)) {
    errors.push(`${rail.railId}: authorityId ${JSON.stringify(rail.authorityId)} is not AUTH-###`);
  }
  if (rail.operations.length === 0) {
    errors.push(`${rail.railId}: declares no operations`);
  }
  if (rail.presets.length === 0) {
    errors.push(`${rail.railId}: declares no scenario presets`);
  }
  const ordinals = new Set<number>();
  for (const preset of rail.presets) {
    if (preset.primitiveIds.length === 0) {
      errors.push(`${rail.railId}/${preset.presetId}: names no primitives`);
    }
    for (const primitiveId of preset.primitiveIds) {
      if (!seenPrimitiveIds.has(primitiveId)) {
        errors.push(
          `${rail.railId}/${preset.presetId}: primitive ${primitiveId} is not in the catalog`,
        );
      }
    }
    if (ordinals.has(preset.authorityScenarioIndex)) {
      errors.push(
        `${rail.railId}: two presets claim authority scenario ordinal ${preset.authorityScenarioIndex}`,
      );
    }
    ordinals.add(preset.authorityScenarioIndex);
  }
}

// (2) The persisted shapes hold refs, never values.
const storeSource = readFileSync(resolve(repoRoot, 'sims/vendor-sim-kit/src/store.ts'), 'utf8');
const riskyFieldName =
  /^(?:.*(?:payload|body|content|value|text|message|note|name|email|phone|address|dob|birth|mrn|ssn).*)$/i;
for (const shape of ['SimEffectRecord', 'SimReceipt']) {
  const declaration = new RegExp(`interface ${shape} \\{([\\s\\S]*?)\\n\\}`).exec(storeSource);
  if (!declaration?.[1]) {
    errors.push(`the persisted shape ${shape} is not declared in the sim store`);
    continue;
  }
  for (const field of declaration[1].matchAll(/^\s*readonly ([A-Za-z0-9_]+)[?]?:/gm)) {
    const fieldName = field[1] ?? '';
    if (riskyFieldName.test(fieldName) && !/(?:Hash|Ref)$/.test(fieldName)) {
      errors.push(
        `${shape}.${fieldName} could hold a value — a persisted sim field with that name must be a ...Hash or ...Ref`,
      );
    }
  }
}

// (3) The same claim, exercised: drive every rail and scan the ledger dump.
const identifiers = ['synthetic-secret-mrn-55512345', 'synthetic-secret-phone-7025550143'];
const engine = new VendorSimEngine({
  rails: railSimsV1,
  store: new InMemorySimStateStore(),
});
for (const rail of railSimsV1) {
  const operation = rail.operations[0] ?? '';
  engine.dispatch({
    railId: rail.railId,
    operation,
    idempotencyKey: `synthetic-gate-${rail.railId.toLowerCase()}`,
    payloadRef: `synthetic-gate-payload-${rail.railId.toLowerCase()}`,
    requestedAt: '2026-01-01T00:00:00Z',
    payload: { mrn: identifiers[0], phone: identifiers[1] },
    synthetic: true,
  });
}
const dump = JSON.stringify(engine.snapshot());
for (const identifier of identifiers) {
  if (dump.includes(identifier)) {
    errors.push(`the sim ledger dump carries a request payload value (${identifier})`);
  }
}

console.log(
  `sim_primitives=${injectionPrimitivesV1.length} declared_rail_sims=${railSimsV1.length} ` +
    `sim_store_payload_leaks=${errors.filter((error) => error.includes('payload value')).length}`,
);
failIfAny('sims', errors);
