import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const requiredFixtureClasses = ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const;
export type FixtureClass = (typeof requiredFixtureClasses)[number];

export interface RequirementFixturePack {
  readonly requirementId: string;
  readonly fixtures: Readonly<Record<FixtureClass, unknown>>;
}

export function assertSyntheticFixture(value: unknown): asserts value is { synthetic: true } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('synthetic' in value) ||
    value.synthetic !== true
  ) {
    throw new Error('Fixture is missing the synthetic watermark.');
  }
}

/**
 * Load a JSON fixture and refuse it unless it carries the synthetic watermark
 * (top-level `"synthetic": true`). Every fixture load path must go through a
 * watermark assertion — unwatermarked data never enters a running stack.
 */
export function loadSyntheticJsonFixture(filePath: string): { synthetic: true } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Fixture ${filePath} is not readable JSON: ${String(error)}`, {
      cause: error,
    });
  }
  try {
    assertSyntheticFixture(parsed);
  } catch {
    throw new Error(`Fixture ${filePath} is missing the synthetic watermark.`);
  }
  return parsed;
}

const fixtureClassPattern = /\.(HAPPY|BOUNDARY|FAILURE|RECOVERY)\.json$/;

/** Extract the fixture class from a `<name>.<CLASS>.json` file name, if present. */
export function fixtureClassFromPath(filePath: string): FixtureClass | null {
  const match = fixtureClassPattern.exec(filePath);
  return match ? (match[1] as FixtureClass) : null;
}

export function requirementFixtureFileName(
  requirementId: string,
  fixtureClass: FixtureClass,
): string {
  return `${requirementId}.${fixtureClass}.json`;
}

/**
 * Load the four-class fixture pack for one canonical requirement from a
 * directory of `<REQ-ID>.<CLASS>.json` files. Fails closed: a missing class or
 * a missing watermark is an error naming exactly what is absent — the
 * per-requirement floor is HAPPY, BOUNDARY, FAILURE, and RECOVERY.
 */
export function loadRequirementFixturePack(
  directory: string,
  requirementId: string,
): RequirementFixturePack {
  const missing: FixtureClass[] = [];
  const fixtures: Partial<Record<FixtureClass, unknown>> = {};
  for (const fixtureClass of requiredFixtureClasses) {
    const filePath = join(directory, requirementFixtureFileName(requirementId, fixtureClass));
    if (!existsSync(filePath)) {
      missing.push(fixtureClass);
      continue;
    }
    fixtures[fixtureClass] = loadSyntheticJsonFixture(filePath);
  }
  if (missing.length > 0) {
    throw new Error(
      `Requirement ${requirementId} is below the fixture floor in ${directory}: ` +
        `missing ${missing.join(', ')} (floor: ${requiredFixtureClasses.join('/')}).`,
    );
  }
  return { requirementId, fixtures: fixtures as Record<FixtureClass, unknown> };
}
