import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { collectFiles, failIfAny, repoRoot } from './common.js';

const errors: string[] = [];
const roots = ['apps', 'modules', 'packages', 'adapters', 'sims', 'tools', 'infra'];
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bsk_live_[A-Za-z0-9]{16,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/,
];

const files = roots.flatMap((root) =>
  collectFiles(resolve(repoRoot, root), (path) => /\.(?:ts|mjs|json|ya?ml|sql|env)$/i.test(path)),
);
files.push(resolve(repoRoot, 'compose.yaml'), resolve(repoRoot, '.env.example'));
const scannerPath = resolve(repoRoot, 'tools/validators/src/secrets.ts');

for (const file of files) {
  if (resolve(file) === scannerPath) {
    continue;
  }
  const content = readFileSync(file, 'utf8');
  if (secretPatterns.some((pattern) => pattern.test(content))) {
    errors.push(relative(repoRoot, file).split(sep).join('/'));
  }
}

failIfAny('secrets', errors);
