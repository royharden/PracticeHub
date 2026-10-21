import assert from 'node:assert/strict';
import test from 'node:test';

import { planChecks } from './verify-staged.mjs';

const pkg = (name) => ({
  name,
  scripts: { build: 'build', lint: 'lint', typecheck: 'typecheck', test: 'test' },
});

test('an isolated urgency fix does not launch unrelated suites', () => {
  const plan = planChecks(['modules/urgency-screen/src/screen.test.ts'], () =>
    pkg('@practicehub/urgency-screen'),
  );
  assert.equal(plan.filter((x) => x.kind === 'workspace').length, 4);
  assert.equal(
    plan.some((x) => x.kind === 'combined'),
    false,
  );
  assert.ok(
    plan
      .filter((x) => x.kind === 'workspace')
      .every((x) => x.args[1] === '@practicehub/urgency-screen'),
  );
});

test('shared graph changes and unknown executable surfaces retain full verification', () => {
  for (const path of [
    'pnpm-lock.yaml',
    'package.json',
    '.github/workflows/verify.yml',
    'tools/scripts/verify.mjs',
    'unknown-driver.py',
  ]) {
    assert.deepEqual(
      planChecks([path], () => null),
      [{ kind: 'combined', command: 'pnpm', args: ['verify'] }],
    );
  }
});

test('documentation alone requires no product suite while hook changes test the selector', () => {
  assert.deepEqual(
    planChecks(['README.md', 'docs/guide.md', 'modules/a/README.md'], () => null),
    [],
  );
  assert.ok(planChecks(['.githooks/pre-commit'], () => null).some((x) => x.kind === 'hook-tests'));
});

test('several packages stay distinct; duplicate paths do not duplicate package gates', () => {
  const plan = planChecks(['modules/a/a.ts', 'modules/a/a.ts', 'modules/b/b.ts'], (path) =>
    pkg(path.includes('/a/') ? 'a' : 'b'),
  );
  assert.equal(plan.filter((x) => x.kind === 'workspace').length, 8);
});

test('missing package gates and path escapes refuse rather than silently pass', () => {
  assert.throws(
    () => planChecks(['modules/a/a.ts'], () => ({ name: 'a', scripts: {} })),
    /required focused script/,
  );
  assert.throws(() => planChecks(['../elsewhere/a.ts'], () => null), /Invalid staged path/);
});
