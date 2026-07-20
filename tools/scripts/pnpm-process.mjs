import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function pnpmInvocation(args) {
  const corepackCli = join(
    dirname(process.execPath),
    'node_modules',
    'corepack',
    'dist',
    'pnpm.js',
  );
  if (existsSync(corepackCli)) {
    return { command: process.execPath, args: [corepackCli, ...args] };
  }
  return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args };
}
