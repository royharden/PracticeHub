import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { collectFiles, failIfAny, repoRoot } from './common.js';

const errors: string[] = [];
const fixtureRoots = ['apps', 'modules', 'packages', 'adapters', 'sims'];
const sensitivePatterns = [
  { label: 'SSN-like value', pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/ },
  {
    label: 'production credential marker',
    pattern: /(?:prod(?:uction)?[_-]?(?:secret|token|password)|BEGIN PRIVATE KEY)/i,
  },
];

for (const root of fixtureRoots) {
  for (const file of collectFiles(resolve(repoRoot, root), (path) =>
    /fixtures?.*\.(?:csv|json|ya?ml)$/i.test(path),
  )) {
    const repoPath = relative(repoRoot, file).split(sep).join('/');
    const content = readFileSync(file, 'utf8');
    for (const { label, pattern } of sensitivePatterns) {
      if (pattern.test(content)) {
        errors.push(`${repoPath} contains ${label}`);
      }
    }
    if (file.endsWith('.json')) {
      const value = JSON.parse(content) as { synthetic?: boolean };
      if (value.synthetic !== true) {
        errors.push(`${repoPath} lacks top-level synthetic=true`);
      }
    }
  }
}

failIfAny('phi_fixtures', errors);
