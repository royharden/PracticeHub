import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pnpmInvocation } from './pnpm-process.mjs';

const globalInputs =
  /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|(?:eslint|prettier)\.config\.[^/]+|\.prettierrc[^/]*|tsconfig[^/]*\.json|\.github\/workflows\/|tools\/scripts\/(?:verify|pnpm-process|turbo-runner)\.mjs$)/;
const workspaceRoots = /^(?:apps|modules|packages|adapters|sims|tools)\//;

// Construction verification only. The unchanged full verifier remains the
// combined-tree/release gate. There is deliberately no skip/failure override.
export function planChecks(paths, packageFor) {
  const files = [...new Set(paths)].map((p) => p.replaceAll('\\', '/'));
  const plans = [];
  const packages = new Map();
  let full = false;
  for (const path of files) {
    if (path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error(`Invalid staged path: ${path}`);
    }
    if (globalInputs.test(path)) {
      full = true;
    } else if (
      path === '.githooks/pre-commit' ||
      /^tools\/scripts\/verify-staged(?:\.test)?\.mjs$/.test(path)
    ) {
      // Verification machinery must check its own selection regressions.
      if (!plans.some((p) => p.kind === 'hook-tests')) {
        plans.push({
          kind: 'hook-tests',
          command: 'node',
          args: ['--test', 'tools/scripts/verify-staged.test.mjs'],
        });
      }
      if (/\.(?:mjs|cjs|js)$/.test(path)) {
        plans.push({
          kind: 'syntax',
          command: 'node',
          args: ['--check', path],
          existingOnly: true,
        });
      }
    } else if (/\.(?:md|txt|svg|png|jpe?g|webp)$/.test(path)) {
      continue;
    } else if (workspaceRoots.test(path)) {
      const pkg = packageFor(path);
      if (!pkg) full = true;
      else packages.set(pkg.name, pkg);
    } else if (!/\.(?:md|txt|svg|png|jpe?g|webp)$/.test(path)) {
      // Unknown executable/config surfaces fail toward the full gate.
      full = true;
    }
  }
  if (full) return [{ kind: 'combined', command: 'pnpm', args: ['verify'] }];
  for (const pkg of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const task of ['build', 'lint', 'typecheck', 'test']) {
      if (!pkg.scripts?.[task])
        throw new Error(`${pkg.name}: required focused script ${task} missing`);
      plans.push({ kind: 'workspace', command: 'pnpm', args: ['--filter', pkg.name, 'run', task] });
    }
  }
  const formatted = files.filter((p) => /\.(?:ts|tsx|js|jsx|mjs|cjs|json|ya?ml)$/.test(p));
  if (formatted.length) {
    plans.push({
      kind: 'format',
      command: 'pnpm',
      args: ['exec', 'prettier', '--check', ...formatted],
      existingOnly: true,
    });
  }
  return plans;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.some((arg) => arg !== '--plan')) throw new Error('Only --plan is supported');
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) throw new Error('Cannot resolve repository root');
  const root = resolve(top.stdout.trim());
  const diff = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRD', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (diff.status !== 0) throw new Error('Cannot inspect staged paths');
  const paths = diff.stdout.split('\0').filter(Boolean);
  const packageFor = (path) => {
    let dir = dirname(resolve(root, path));
    while (dir !== root && relative(root, dir).split(sep)[0] !== '..') {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8'));
      dir = dirname(dir);
    }
    return null;
  };
  const plan = planChecks(paths, packageFor);
  if (argv.includes('--plan')) {
    console.log(
      JSON.stringify({ phase: 'construction', paths, plan, productAcceptance: false }, null, 2),
    );
    return;
  }
  for (const step of plan) {
    const args = step.existingOnly
      ? step.args.filter((arg) => !paths.includes(arg) || existsSync(join(root, arg)))
      : step.args;
    if (step.kind === 'syntax' && args.length < 2) continue;
    if (step.kind === 'format' && args.length < 4) continue;
    const invocation =
      step.command === 'pnpm' ? pnpmInvocation(args) : { command: process.execPath, args };
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
