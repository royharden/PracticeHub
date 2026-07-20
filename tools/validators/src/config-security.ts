import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { failIfAny, repoRoot } from './common.js';

const compose = readFileSync(join(repoRoot, 'compose.yaml'), 'utf8');
const vendorDockerfile = readFileSync(join(repoRoot, 'sims/vendor-simulator/Dockerfile'), 'utf8');
const errors: string[] = [];
const requiredServices = [
  'app-postgres',
  'minio',
  'dex',
  'mailpit',
  'vendor-simulator',
  'medplum-postgres',
  'medplum-redis',
  'medplum-server',
  'medplum-app',
  'otel-lgtm',
];

for (const service of requiredServices) {
  if (!new RegExp(`^  ${service}:`, 'm').test(compose)) {
    errors.push(`compose missing service ${service}`);
  }
}
for (const imageLine of compose.match(/^\s+image:\s+.+$/gm) ?? []) {
  if (!imageLine.includes('@sha256:')) {
    errors.push(`image is not digest pinned: ${imageLine.trim()}`);
  }
}
if (!/^FROM\s+\S+@sha256:[a-f0-9]{64}\s*$/m.test(vendorDockerfile)) {
  errors.push('vendor simulator base image is not digest pinned');
}
for (const portLine of compose.match(/^\s+- ['"]?[^'"\n]+:[^'"\n]+['"]?\s*$/gm) ?? []) {
  if (/\d+:\d+/.test(portLine) && !portLine.includes('127.0.0.1:')) {
    errors.push(`published port is not loopback-only: ${portLine.trim()}`);
  }
}
for (const required of [
  'tls_floor: TLSv1.3',
  'at_rest: synthetic-named-volume',
  'data_policy: synthetic-only',
  'practicehub.security.at-rest=synthetic-named-volume',
]) {
  if (!compose.includes(required)) {
    errors.push(`compose security contract missing ${required}`);
  }
}

failIfAny('config_security', errors);
