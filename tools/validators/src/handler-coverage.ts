/**
 * Handler-coverage lint (WP-012; ADR-011 Decision 2). Contract convention
 * (docs/contracts/capability-registry.md): side-effecting command handlers
 * live in `modules/<m>/src/**{@literal /}commands/*.command.ts` (same for adapters) and
 * every exported handler is constructed through `defineCommandHandler`, which
 * performs the `requireCapability` check before the handler body runs. This
 * lint makes the convention machine-enforced:
 *
 * - a file inside a `commands/` directory must be a `*.command.ts` handler
 *   file (or an `index.ts` barrel) — no side doors;
 * - a `*.command.ts` file must construct at least one handler;
 * - a `*.command.ts` file may export only `const` bindings assigned from
 *   `defineCommandHandler(...)` (plus types/interfaces) — raw functions,
 *   classes, or default exports cannot masquerade as handlers.
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { collectFiles, failIfAny, repoRoot } from './common.js';

const roots = ['modules', 'adapters'];
const errors: string[] = [];
let commandFiles = 0;
let handlers = 0;

for (const root of roots) {
  const absoluteRoot = resolve(repoRoot, root);
  if (!existsSync(absoluteRoot)) {
    continue;
  }
  for (const file of collectFiles(absoluteRoot, (path) => path.endsWith('.ts'))) {
    const repoPath = relative(repoRoot, file).split(sep).join('/');
    if (!repoPath.includes('/src/')) {
      continue;
    }
    const inCommandsDirectory = /\/src\/(?:.*\/)?commands\//.test(repoPath);
    const isCommandFile = repoPath.endsWith('.command.ts');
    if (inCommandsDirectory && !isCommandFile && !repoPath.endsWith('/index.ts')) {
      errors.push(
        `${repoPath} sits in a commands/ directory but is not a *.command.ts handler file`,
      );
      continue;
    }
    if (!isCommandFile) {
      continue;
    }
    commandFiles += 1;
    const content = readFileSync(file, 'utf8');

    const constructions = content.match(/defineCommandHandler\s*[(<]/g) ?? [];
    handlers += constructions.length;
    if (constructions.length === 0) {
      errors.push(
        `${repoPath} declares no defineCommandHandler — a command file must construct its ` +
          'handlers through the capability-checked constructor',
      );
    }

    const rawExport = /export\s+(?:default|function|class|let|var|async)\b/.exec(content);
    if (rawExport) {
      errors.push(
        `${repoPath} exports via ${JSON.stringify(rawExport[0])} — command files may export ` +
          'only const handlers built with defineCommandHandler (plus types)',
      );
    }
    for (const match of content.matchAll(/export\s+const\s+(\w+)[^=]*=\s*([A-Za-z_$][\w$]*)/g)) {
      if (match[2] !== 'defineCommandHandler') {
        errors.push(
          `${repoPath} exports const ${match[1] ?? '?'} assigned from ${match[2] ?? '?'} — ` +
            'every exported handler must be a defineCommandHandler(...) construction',
        );
      }
    }
  }
}

console.log(`command_files=${commandFiles} handlers=${handlers}`);
failIfAny('handler_coverage', errors);
