import { spawnSync } from 'node:child_process';

import { pnpmInvocation } from './pnpm-process.mjs';

const steps = [
  ['-r', 'build'],
  ['-r', 'lint'],
  ['-r', 'typecheck'],
  ['-r', 'test'],
  ['verify:imports'],
  ['verify:planning'],
  ['verify:corpus'],
  ['verify:publication'],
  ['verify:temporal'],
  ['verify:secrets'],
  ['verify:phi'],
  ['verify:cross-tenant'],
  ['verify:config'],
  ['format:check'],
];

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
