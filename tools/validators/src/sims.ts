/**
 * Vendor-sim gate (WP-027; ADR-003/ADR-014). PUBLIC step — everything it reads
 * is platform code, so a public clone runs it exactly as the development
 * machine does.
 *
 * Three things the WP-027 gate names, extended by WP-028 at (1c):
 *   1. the injection-primitive catalog is complete and well-formed (eighteen
 *      unique, contiguous `X-##` ids drawn from the declared vocabularies), and
 *      every declared rail is a complete declaration bound to an `AUTH-###`
 *      authority with distinct scenario ordinals and catalog-known primitives
 *      — plus (1c) an expected-volume band each rail is EXERCISED against on a
 *      silent window, so `sim_rails_loud_when_silent` is an earned count rather
 *      than a restatement of how many rails carry a mandatory field;
 *   2. "PHI scan of sim stores", STATICALLY: the persisted sim shapes
 *      (`SimEffectRecord`, `SimReceipt`, `SimHeartbeat`) may not carry a field
 *      that could hold a value rather than a reference — a risky field name is
 *      admissible only as a `...Hash` or `...Ref`;
 *   3. "PHI scan of sim stores", DYNAMICALLY: a request whose payload carries
 *      identifiers is driven through every rail, and the resulting ledger dump
 *      is scanned for those values. Structure is asserted AND exercised.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assertRailHeartbeatModel,
  evaluateRailHeartbeat,
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
/**
 * Rails PROVEN loud on a silent window — not a count of rails carrying the
 * (mandatory, therefore tautological) field. It equals `declared_rail_sims`
 * only when every band was actually exercised and alarmed.
 */
let railsLoudWhenSilent = 0;
/** Rails whose band was refused at (1c); section (3) must not construct them. */
const railsWithRefusedBands = new Set<string>();
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
  // (1c) WP-028: every rail carries an expected-volume band under which total
  // silence is loud. `assertRailHeartbeatModel` is the same check the engine
  // applies at construction — the gate states it so a rail cannot reach the
  // service without one. A rail whose model is already refused is NOT then
  // evaluated: `evaluateRailHeartbeat` re-asserts and would throw, turning a
  // named gate failure into a stack trace.
  try {
    assertRailHeartbeatModel(rail.railId, rail.heartbeat);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    railsWithRefusedBands.add(rail.railId);
    continue;
  }
  const silent = evaluateRailHeartbeat(rail.heartbeat, {
    railId: rail.railId,
    observedEffects: 0,
    observedHeartbeats: 0,
    reconciliationRan: true,
  });
  if (silent.verdict === 'alarm') {
    railsLoudWhenSilent += 1;
  } else {
    errors.push(`${rail.railId}: a silent reconciliation window does not alarm under its band`);
  }
}

// (2) The persisted shapes hold refs, never values.
const storeSource = readFileSync(resolve(repoRoot, 'sims/vendor-sim-kit/src/store.ts'), 'utf8');
const riskyFieldName =
  /^(?:.*(?:payload|body|content|value|text|message|note|name|email|phone|address|dob|birth|mrn|ssn).*)$/i;
for (const shape of ['SimEffectRecord', 'SimReceipt', 'SimHeartbeat']) {
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
//
// Only rails whose band survived (1c) are driven. `VendorSimEngine` re-asserts
// the model at construction, so passing a refused rail here would abort the run
// with a stack trace — losing this section's findings AND the receipt line to a
// fault (1c) has already named precisely. A gate must report, not crash.
const identifiers = ['synthetic-secret-mrn-55512345', 'synthetic-secret-phone-7025550143'];
const drivableRails = railSimsV1.filter((rail) => !railsWithRefusedBands.has(rail.railId));
const engine = new VendorSimEngine({
  rails: drivableRails,
  store: new InMemorySimStateStore(),
});
for (const rail of drivableRails) {
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
  // The heartbeat records land in the same dump, so the scan covers the WP-028
  // surface too rather than only the effect ledger.
  engine.recordHeartbeat(rail.railId, '2026-01-01T00:00:00Z');
}
const dump = JSON.stringify({ state: engine.snapshot(), heartbeat: engine.heartbeatSweep() });
for (const identifier of identifiers) {
  if (dump.includes(identifier)) {
    errors.push(`the sim ledger dump carries a request payload value (${identifier})`);
  }
}

console.log(
  `sim_primitives=${injectionPrimitivesV1.length} declared_rail_sims=${railSimsV1.length} ` +
    `sim_rails_loud_when_silent=${railsLoudWhenSilent} ` +
    `sim_store_payload_leaks=${errors.filter((error) => error.includes('payload value')).length}`,
);
failIfAny('sims', errors);
