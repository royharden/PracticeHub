import {
  mirrorKey,
  RcmShadowError,
  type PresentedCredential,
  type SealedMirror,
  type ShadowCredential,
  type Wp056LedgerPort,
  type MirrorBody,
} from './contracts.js';
import { sealMirror } from './seal.js';

export class ShadowStore {
  private readonly mirrors = new Map<string, SealedMirror>();

  public constructor(
    private readonly liveCredentialIds: ReadonlySet<string>,
    private readonly ledger: Wp056LedgerPort,
  ) {
    if (ledger.packageId !== 'WP-056') {
      throw new RcmShadowError(
        'WP056_PORT',
        'shadow store posts only through the WP-056 placeholder',
      );
    }
    // Runtime check: a live ledger cast to this type must still be refused.
    const journal: unknown = (ledger as { readonly journal?: unknown }).journal;
    if (journal !== 'shadow') {
      throw new RcmShadowError(
        'SHADOW_JOURNAL_REQUIRED',
        'shadow postings go only to a shadow journal, never the live ledger',
      );
    }
  }

  public append(input: MirrorBody, credential: PresentedCredential): SealedMirror {
    const shadow = this.requireShadowCredential(credential);
    // A private frozen copy: later caller mutation cannot change a sealed mirror.
    const body: MirrorBody = Object.freeze({
      tenantId: input.tenantId,
      kind: input.kind,
      controlNumber: input.controlNumber,
      amountMinor: input.amountMinor,
      currency: input.currency,
      payload: input.payload,
    });
    const sealed = sealMirror(body);
    const key = mirrorKey(body);
    const existing = this.mirrors.get(key);
    if (existing) {
      if (existing.seal !== sealed.seal) {
        throw new RcmShadowError('SEAL_CONFLICT', 'a sealed mirror cannot be replaced');
      }
      return existing;
    }
    const ledgerPosting =
      body.kind === '835'
        ? Object.freeze({
            ...this.ledger.record({
              packageId: 'WP-056',
              postingId: `wp056-${sealed.seal.slice(0, 16)}`,
              tenantId: body.tenantId,
              amountMinor: body.amountMinor,
              currency: 'USD',
              sourceSeal: sealed.seal,
            }),
          })
        : null;
    const record: SealedMirror = Object.freeze({
      seal: sealed.seal,
      canonical: sealed.canonical,
      body,
      credential: Object.freeze({ ...shadow }),
      ledgerPosting,
    });
    this.mirrors.set(key, record);
    return record;
  }

  public list(): readonly SealedMirror[] {
    return Object.freeze([...this.mirrors.values()]);
  }

  private requireShadowCredential(credential: PresentedCredential): ShadowCredential {
    if (credential.class !== 'shadow') {
      throw new RcmShadowError(
        'LIVE_CREDENTIAL',
        'a live rail credential cannot seal shadow output',
      );
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(credential.credentialId)) {
      throw new RcmShadowError('INVALID_CREDENTIAL', 'shadow credentialId must be a token');
    }
    if (this.liveCredentialIds.has(credential.credentialId)) {
      throw new RcmShadowError(
        'LIVE_CREDENTIAL',
        'shadow credentialId must be distinct from every live rail credential',
      );
    }
    return { class: 'shadow', credentialId: credential.credentialId };
  }
}
