/**
 * Adapter-framework gate (WP-026; ADR-014 Decision 1). PRIVATE step — it reads
 * docs/architecture/authority-rail-join.csv (gitignored), so it lives in the
 * private verify set alongside verify:planning.
 *
 * Enforces three things the WP-026 gate names:
 *   1. The authority-rail JOIN is FROZEN — its column set matches the executable
 *      mirror (`authorityRailJoinColumns`, @practicehub/platform-integration),
 *      and every row is a COMPLETE binding: an AUTH id, EXACTLY ONE of a rail
 *      list (external adapter) or a no-external-rail basis (internal authority),
 *      and non-empty effect-key contract, simulator scenario(s), late-outcome
 *      rule, and activation evidence. "Every external adapter maps to the join
 *      and names its late-outcome scenario" — enforced over the real rows.
 *   2. Contract-presence — any adapter under adapters/ that DECLARES a contract
 *      (a `*.adapter-contract.ts` file) must name an `authorityId` present in the
 *      join. An adapter package without a declared contract is reported as
 *      DEFERRED (its owning package registers it), never silently passed.
 *   3. The executable AdapterContract required-field set is non-empty (the
 *      framework surface exists).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import {
  adapterContractRequiredFields,
  authorityIdPattern,
  authorityRailJoinColumns,
  railIdPattern,
} from '@practicehub/platform-integration';
import { parseCsv } from '@practicehub/testkit';
import { railSimsV1 } from '@practicehub/vendor-simulator';

import { collectFiles, failIfAny, repoRoot } from './common.js';

const errors: string[] = [];

const joinPath = 'docs/architecture/authority-rail-join.csv';
const joinRows = parseCsv(readFileSync(resolve(repoRoot, joinPath), 'utf8'));
const header = joinRows[0] ?? [];

// (1) Column freeze: the CSV header equals the executable mirror, order-exact.
if (header.join(',') !== authorityRailJoinColumns.join(',')) {
  errors.push(
    `authority-rail join header drifted: csv=[${header.join(', ')}] code=[${authorityRailJoinColumns.join(', ')}]`,
  );
}

const columnIndex = new Map(header.map((name, index) => [name, index] as const));
const cell = (row: readonly string[], name: string): string => {
  const index = columnIndex.get(name);
  return index === undefined ? '' : (row[index] ?? '').trim();
};

const authorityIds = new Set<string>();
/** authority id -> how many simulator scenarios its join row names (WP-027). */
const authorityScenarioCounts = new Map<string, number>();
let externalRails = 0;
for (const [index, row] of joinRows.slice(1).entries()) {
  if (row.every((value) => value.trim() === '')) {
    continue;
  }
  const rowNo = index + 2;
  const authorityId = cell(row, 'authority_id');
  if (!authorityIdPattern.test(authorityId)) {
    errors.push(
      `authority-rail row ${rowNo}: authority_id ${JSON.stringify(authorityId)} is not an AUTH-### id`,
    );
    continue;
  }
  authorityIds.add(authorityId);
  const railIds = cell(row, 'rail_ids');
  const noRailBasis = cell(row, 'no_external_rail_basis');
  // Every authority is either an external adapter (rail ids), a purely internal
  // authority (a documented reason it needs no external rail), or both (a rail
  // for one facet plus a documented no-effect basis for another — AUTH-004
  // e-sign, AUTH-023 licensed content). Never neither.
  if (railIds === '' && noRailBasis === '') {
    errors.push(`${authorityId}: must carry rail_ids or a no_external_rail_basis (never neither)`);
  }
  if (railIds !== '') {
    externalRails += 1;
    for (const railId of railIds.split('|')) {
      if (!railIdPattern.test(railId.trim())) {
        errors.push(`${authorityId}: rail id ${JSON.stringify(railId)} is not a RAIL-### id`);
      }
    }
  }
  authorityScenarioCounts.set(
    authorityId,
    cell(row, 'simulator_scenarios')
      .split('|')
      .filter((scenario) => scenario.trim() !== '').length,
  );
  // Every row is a complete contract binding.
  for (const column of [
    'effect_key_contract',
    'simulator_scenarios',
    'late_outcome_rule',
    'activation_evidence',
  ]) {
    if (cell(row, column) === '') {
      errors.push(`${authorityId}: ${column} must be present (a complete contract binding)`);
    }
  }
}

// (2) Contract-presence scan of adapters/. A declared contract file names its
// authorityId; a bare adapter package (no declared contract) is deferred.
const adaptersRoot = resolve(repoRoot, 'adapters');
let declaredContracts = 0;
const deferredAdapters: string[] = [];
if (existsSync(adaptersRoot)) {
  const contractFiles = collectFiles(adaptersRoot, (path) => path.endsWith('.adapter-contract.ts'));
  for (const file of contractFiles) {
    declaredContracts += 1;
    const repoPath = relative(repoRoot, file).split(sep).join('/');
    const content = readFileSync(file, 'utf8');
    const match = /authorityId\s*:\s*['"]([^'"]+)['"]/.exec(content);
    if (!match) {
      errors.push(`${repoPath} declares an adapter contract but names no authorityId`);
      continue;
    }
    if (!authorityIds.has(match[1] ?? '')) {
      errors.push(
        `${repoPath} names authorityId ${JSON.stringify(match[1])} absent from the authority-rail join`,
      );
    }
  }
  for (const entry of readdirSync(adaptersRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') {
      continue;
    }
    const hasContract = contractFiles.some(
      (file) => relative(adaptersRoot, file).split(sep)[0] === entry.name,
    );
    if (!hasContract) {
      deferredAdapters.push(entry.name);
    }
  }
}

// (3) The framework surface exists.
if (adapterContractRequiredFields.length === 0) {
  errors.push('adapterContractRequiredFields is empty — the AdapterContract shape is undefined');
}

// (4) WP-027: every rail sim maps to the join, and every simulator scenario an
// IMPLEMENTED authority names has exactly one declared preset. Presets bind by
// ORDINAL, so the public rail code never mirrors the private join's scenario
// strings. Scenarios of an implemented authority whose other rails are not built
// yet, and authorities with no rail at all, are REPORTED as deferred — never
// silently passed (the adapter_contracts_deferred discipline).
const coveredScenarios = new Map<string, Set<number>>();
for (const rail of railSimsV1) {
  const scenarioCount = authorityScenarioCounts.get(rail.authorityId);
  if (scenarioCount === undefined) {
    errors.push(
      `${rail.railId}: authorityId ${rail.authorityId} is absent from the authority-rail join`,
    );
    continue;
  }
  const covered = coveredScenarios.get(rail.authorityId) ?? new Set<number>();
  for (const preset of rail.presets) {
    if (preset.authorityScenarioIndex >= scenarioCount) {
      errors.push(
        `${rail.railId}/${preset.presetId}: authority scenario ordinal ${preset.authorityScenarioIndex} ` +
          `exceeds the ${scenarioCount} scenario(s) ${rail.authorityId} names`,
      );
      continue;
    }
    if (covered.has(preset.authorityScenarioIndex)) {
      errors.push(
        `${rail.authorityId} scenario ordinal ${preset.authorityScenarioIndex} is claimed by two presets`,
      );
    }
    covered.add(preset.authorityScenarioIndex);
  }
  coveredScenarios.set(rail.authorityId, covered);
}

const deferredScenarios: string[] = [];
const deferredAuthorities: string[] = [];
for (const [authorityId, scenarioCount] of [...authorityScenarioCounts.entries()].sort()) {
  const covered = coveredScenarios.get(authorityId);
  if (covered === undefined) {
    deferredAuthorities.push(authorityId);
    continue;
  }
  const uncovered = Array.from({ length: scenarioCount }, (_, index) => index).filter(
    (index) => !covered.has(index),
  );
  for (const index of uncovered) {
    deferredScenarios.push(`${authorityId}:${index}`);
  }
}
if (deferredAuthorities.length > 0) {
  console.log(`sim_rails_deferred=${deferredAuthorities.join(',')}`);
}
if (deferredScenarios.length > 0) {
  console.log(`sim_scenarios_deferred=${deferredScenarios.join(',')}`);
}
const coveredCount = [...coveredScenarios.values()].reduce(
  (total, covered) => total + covered.size,
  0,
);
console.log(`declared_rail_sims=${railSimsV1.length} covered_authority_scenarios=${coveredCount}`);

if (deferredAdapters.length > 0) {
  // No silent caps: name the adapters whose contracts are deferred to their
  // owning packages (WP-027/028/055/060...); FWD-ADAPTER-027-CONTRACTS.
  console.log(`adapter_contracts_deferred=${deferredAdapters.sort().join(',')}`);
}
console.log(
  `authority_rail_rows=${authorityIds.size} external_rails=${externalRails} ` +
    `declared_adapter_contracts=${declaredContracts}`,
);
failIfAny('adapters', errors);
