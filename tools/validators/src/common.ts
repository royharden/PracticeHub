import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function collectFiles(root: string, predicate: (path: string) => boolean): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectFiles(path, predicate));
    } else if (predicate(path)) {
      result.push(path);
    }
  }
  return result;
}

export function failIfAny(label: string, errors: readonly string[]): void {
  if (errors.length === 0) {
    console.log(`${label}=OK`);
    return;
  }
  for (const error of errors) {
    console.error(`${label}=FAIL ${error}`);
  }
  process.exitCode = 1;
}
