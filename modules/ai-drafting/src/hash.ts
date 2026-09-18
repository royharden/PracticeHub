import { createHash } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashRecord(value: unknown): string {
  return sha256(JSON.stringify(value));
}
