import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCsv, records } from '@practicehub/testkit';

import { failIfAny, repoRoot } from './common.js';

function load(relativePath: string): string[][] {
  return parseCsv(readFileSync(join(repoRoot, relativePath), 'utf8'));
}

function dependencyIds(value: string): string[] {
  const result: string[] = [];
  const regex = /WP-(\d{3})(?:\.\.(\d{3}))?/g;
  for (const match of value.matchAll(regex)) {
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    for (let current = start; current <= end; current += 1) {
      result.push(`WP-${String(current).padStart(3, '0')}`);
    }
  }
  return result;
}

const errors: string[] = [];
const workRows = load('planning/work-packages.csv');
const headerWidth = workRows[0]?.length ?? 0;
for (const [index, row] of workRows.entries()) {
  if (row.length !== headerWidth) {
    errors.push(
      `work-packages.csv row ${index + 1} has ${row.length} fields; expected ${headerWidth}`,
    );
  }
}

const packages = records(workRows);
const packageIds = new Set(packages.map((row) => row.wp_id ?? ''));
if (packages.length !== 111) {
  errors.push(`work-packages.csv contains ${packages.length} packages; expected 111`);
}
for (const row of packages) {
  if (row.grafts_pending?.trim()) {
    errors.push(`${row.wp_id} retains graft ${row.grafts_pending}`);
  }
}

const graph = new Map<string, string[]>();
for (const row of records(load('planning/package-dependencies.csv'))) {
  const id = row.wp_id ?? '';
  const dependencies = dependencyIds(row.depends_on ?? '');
  for (const dependency of dependencies) {
    if (!packageIds.has(dependency)) {
      errors.push(`${id} references missing ${dependency}`);
    }
  }
  graph.set(id, dependencies);
}

const visiting = new Set<string>();
const visited = new Set<string>();
function visit(id: string, stack: readonly string[]): void {
  if (visiting.has(id)) {
    errors.push(`dependency cycle ${[...stack, id].join(' -> ')}`);
    return;
  }
  if (visited.has(id)) {
    return;
  }
  visiting.add(id);
  for (const dependency of graph.get(id) ?? []) {
    visit(dependency, [...stack, id]);
  }
  visiting.delete(id);
  visited.add(id);
}
for (const id of graph.keys()) {
  visit(id, []);
}

const capabilityRows = records(load('docs/architecture/capability-edge-preconditions.csv'));
const capabilityIds = new Set(capabilityRows.map((row) => row.constraint_id));
for (let index = 1; index <= 6; index += 1) {
  if (!capabilityIds.has(`IC-${index}`)) {
    errors.push(`missing capability edge IC-${index}`);
  }
}

const authorityRows = load('docs/architecture/authority-rail-join.csv');
const authorityHeader = new Set(authorityRows[0] ?? []);
for (const required of [
  'authority_id',
  'rail_ids',
  'effect_key_contract',
  'simulator_scenarios',
  'late_outcome_rule',
  'activation_evidence',
]) {
  if (!authorityHeader.has(required)) {
    errors.push(`authority-rail join missing ${required}`);
  }
}

console.log(
  `work_packages=${packages.length} grafts_pending=0 capability_edges=${capabilityRows.length}`,
);
failIfAny('planning', errors);
