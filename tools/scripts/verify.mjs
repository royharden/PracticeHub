import { spawnSync } from 'node:child_process';

import { pnpmInvocation } from './pnpm-process.mjs';

// --public: the gate subset a public clone can run. The excluded gates read
// private, gitignored inputs that exist only on the development machine
// (planning/, docs/requirements/, publication/) and MUST NOT be skipped
// silently in local/full mode — absence there is a failure, not a skip.
const publicMode = process.argv.includes('--public');

const publicSteps = [
  ['-r', 'build'],
  ['-r', 'lint'],
  ['-r', 'typecheck'],
  ['-r', 'test'],
  ['verify:imports'],
  ['verify:handlers'],
  // WP-027: the vendor-sim gate reads only platform code (catalog, rail
  // declarations, the sim store's own shape), so it is a PUBLIC step.
  ['verify:sims'],
  ['verify:secrets'],
  ['verify:phi'],
  ['verify:cross-tenant'],
  ['verify:config'],
  ['format:check'],
];

const privateSteps = [
  ['verify:planning'],
  // WP-026: reads docs/architecture/authority-rail-join.csv (gitignored), so it
  // is a private step — a public clone cannot run it.
  ['verify:adapters'],
  ['verify:corpus'],
  ['verify:publication'],
  ['verify:temporal'],
];

const steps = publicMode
  ? publicSteps
  : [...publicSteps.slice(0, 5), ...privateSteps, ...publicSteps.slice(5)];

for (const args of steps) {
  const invocation = pnpmInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
