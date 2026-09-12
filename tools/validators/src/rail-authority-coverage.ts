import { normalizeRailAuthorityBindings, type RailSim } from '@practicehub/vendor-sim-kit';

export interface AuthorityRailCoverageRow {
  readonly railIds: readonly string[];
  readonly scenarioCount: number;
}

/** Pure private-join check: a declared operation and a covered scenario are different claims. */
export function checkRailAuthorityCoverage(
  rails: readonly RailSim[],
  join: ReadonlyMap<string, AuthorityRailCoverageRow>,
): { errors: string[]; coveredScenarios: Map<string, Set<number>> } {
  const errors: string[] = [];
  const coveredScenarios = new Map<string, Set<number>>();
  for (const rail of rails) {
    let bindings;
    try {
      bindings = normalizeRailAuthorityBindings(rail);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    for (const authority of new Set(bindings.operations.values())) {
      const row = join.get(authority);
      if (row === undefined || !row.railIds.includes(rail.railId)) {
        errors.push(`${rail.railId}: authority ${authority} does not name this rail in the join`);
      }
    }
    for (const { preset, authorityId } of bindings.presets) {
      const row = join.get(authorityId);
      if (row === undefined || !row.railIds.includes(rail.railId)) continue;
      if (preset.authorityScenarioIndex >= row.scenarioCount) {
        errors.push(
          `${rail.railId}/${preset.presetId}: authority scenario ordinal ${preset.authorityScenarioIndex} exceeds the ${row.scenarioCount} scenario(s) ${authorityId} names`,
        );
        continue;
      }
      const covered = coveredScenarios.get(authorityId) ?? new Set<number>();
      if (covered.has(preset.authorityScenarioIndex)) {
        errors.push(
          `${authorityId} scenario ordinal ${preset.authorityScenarioIndex} is claimed by two presets`,
        );
      }
      covered.add(preset.authorityScenarioIndex);
      coveredScenarios.set(authorityId, covered);
    }
  }
  return { errors, coveredScenarios };
}
