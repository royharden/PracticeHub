/** Operation ownership and preset attribution (ADR-ADJ-017). No caller chooses authority. */
import { authorityIdPattern } from '@practicehub/platform-integration';

import { RailSimError, type RailScenarioPreset, type RailSim } from './rail.js';
import { simRefPattern } from './store.js';

export interface ResolvedRailPreset {
  readonly preset: RailScenarioPreset;
  readonly operation: string;
  readonly authorityId: string;
}

export interface RailAuthorityBindings {
  readonly operations: ReadonlyMap<string, string>;
  readonly presets: readonly ResolvedRailPreset[];
}

/** Total, fail-closed normalization shared by construction, validators and tests. */
export function normalizeRailAuthorityBindings(rail: RailSim): RailAuthorityBindings {
  const fail = (reason: string): never => {
    throw new RailSimError(`${rail.railId}: ${reason}`);
  };
  const validAuthority = (value: unknown): value is string =>
    typeof value === 'string' && authorityIdPattern.test(value);
  if (!validAuthority(rail.authorityId)) fail('invalid legacy authorityId');
  if (rail.operations.length === 0) fail('no operations');
  const operations = new Map<string, string>();
  const declared = rail.operationAuthorities;
  if (
    declared !== undefined &&
    (declared === null || typeof declared !== 'object' || Array.isArray(declared))
  ) {
    fail('operationAuthorities must be a total scalar map');
  }
  for (const operation of rail.operations) {
    if (typeof operation !== 'string' || !simRefPattern.test(operation)) fail('invalid operation');
    if (operations.has(operation)) fail(`duplicate operation ${operation}`);
    const authority =
      declared === undefined
        ? rail.authorityId
        : Object.hasOwn(declared, operation)
          ? declared[operation]
          : undefined;
    if (!validAuthority(authority)) fail(`missing or invalid authority for ${operation}`);
    operations.set(operation, authority as string);
  }
  if (declared !== undefined && Object.keys(declared).some((key) => !operations.has(key))) {
    fail('operationAuthorities contains undeclared operation');
  }
  if (![...operations.values()].includes(rail.authorityId))
    fail('legacy authority owns no operation');
  const ids = new Set<string>();
  const tuples = new Set<string>();
  const presets = rail.presets.map((preset): ResolvedRailPreset => {
    if (ids.has(preset.presetId)) fail(`duplicate presetId ${preset.presetId}`);
    ids.add(preset.presetId);
    if (!Number.isInteger(preset.authorityScenarioIndex) || preset.authorityScenarioIndex < 0) {
      fail(`invalid authority ordinal in ${preset.presetId}`);
    }
    if ((preset.operation === undefined) !== (preset.authorityId === undefined)) {
      fail(`preset ${preset.presetId} must name both operation and authorityId`);
    }
    const operation = preset.operation ?? rail.operations[0];
    const authorityId = preset.authorityId ?? rail.authorityId;
    if (
      operation === undefined ||
      !validAuthority(authorityId) ||
      operations.get(operation) !== authorityId
    ) {
      fail(`preset ${preset.presetId} operation/authority mismatch`);
    }
    const tuple = `${authorityId}:${String(preset.authorityScenarioIndex)}`;
    if (tuples.has(tuple)) fail(`duplicate authority scenario ${tuple}`);
    tuples.add(tuple);
    return { preset, operation: operation as string, authorityId };
  });
  return { operations, presets };
}

/** Untyped callers must not mistake ignored selectors for an authority grant. */
export function refuseRailAuthoritySelectors(input: unknown): void {
  if (
    input !== null &&
    typeof input === 'object' &&
    ['authorityId', 'authorityIds', 'operationAuthorities'].some((key) => key in input)
  ) {
    throw new RailSimError('caller authority selector is forbidden');
  }
}
