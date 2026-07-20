import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { collectFiles, failIfAny, repoRoot } from './common.js';

const roots = ['apps', 'modules', 'packages', 'adapters', 'sims', 'tools'];
const vendorImports = [/^@medplum\//, /^stripe$/, /^twilio$/, /^@aws-sdk\//, /^dosespot/, /^stedi/];
const importPattern = /(?:from\s+|import\s*\()(['"])([^'"]+)\1/g;
const errors: string[] = [];

for (const root of roots) {
  const absoluteRoot = resolve(repoRoot, root);
  for (const file of collectFiles(absoluteRoot, (path) => path.endsWith('.ts'))) {
    const repoPath = relative(repoRoot, file).split(sep).join('/');
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[2];
      if (!specifier) {
        continue;
      }
      if (
        vendorImports.some((pattern) => pattern.test(specifier)) &&
        !repoPath.startsWith('adapters/')
      ) {
        errors.push(`${repoPath} imports vendor package ${specifier} outside adapters`);
      }
      const moduleMatch = /^@practicehub\/module-([^/]+)(\/.*)?$/.exec(specifier);
      if (moduleMatch?.[2] && moduleMatch[2] !== '/api') {
        errors.push(`${repoPath} imports module internals through ${specifier}`);
      }
    }
  }
}

failIfAny('import_boundaries', errors);
