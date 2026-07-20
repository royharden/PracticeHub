import { spawnSync } from 'node:child_process';

import { pnpmInvocation } from './pnpm-process.mjs';

// Composite corpus gate (WP-005): the graduated-corpus count/integrity check
// (892/751/751) followed by the corpus validators (SynthCorpus manifest
// checkpoint + fenced-artifact hashes + synthetic watermarks + persona×story
// matrix regeneration and fixture floor).
const steps = [
  {
    command: 'python',
    args: ['docs/requirements/union-tools/build_canonical.py', '--verify-graduated'],
  },
  (() => {
    const invocation = pnpmInvocation([
      '--filter',
      '@practicehub/validators',
      'run',
      'verify:corpus',
    ]);
    return { command: invocation.command, args: invocation.args };
  })(),
];

for (const step of steps) {
  const result = spawnSync(step.command, step.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
