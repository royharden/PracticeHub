import { createHash } from 'node:crypto';

import { assertMirrorBody, type MirrorBody } from './contracts.js';

export function canonicalMirror(body: MirrorBody): string {
  assertMirrorBody(body);
  return JSON.stringify({
    amountMinor: body.amountMinor,
    controlNumber: body.controlNumber,
    currency: body.currency,
    kind: body.kind,
    payload: body.payload,
    tenantId: body.tenantId,
  });
}

export function sealCanonical(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function sealMirror(body: MirrorBody): {
  readonly canonical: string;
  readonly seal: string;
} {
  const canonical = canonicalMirror(body);
  return { canonical, seal: sealCanonical(canonical) };
}
