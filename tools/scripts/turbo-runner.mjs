import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { pnpmInvocation } from './pnpm-process.mjs';

const task = process.argv[2];
if (!task) {
  throw new Error('A Turbo task is required.');
}

const cacheDir = join(
  process.env.LOCALAPPDATA ?? process.env.TMPDIR ?? process.cwd(),
  'PracticeHub',
  'cache',
  'turbo',
);
const invocation = pnpmInvocation(['exec', 'turbo', 'run', task, `--cache-dir=${cacheDir}`]);
const result = spawnSync(invocation.command, invocation.args, {
  cwd: process.cwd(),
  env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
