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
  }

  public append(body: MirrorBody, credential: PresentedCredential): SealedMirror {
    const shadow = this.requireShadowCredential(credential);
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
        ? this.ledger.record({
            packageId: 'WP-056',
            postingId: `wp056-${sealed.seal.slice(0, 16)}`,
            tenantId: body.tenantId,
            amountMinor: body.amountMinor,
            currency: 'USD',
            sourceSeal: sealed.seal,
          })
        : null;
    const record: SealedMirror = {
      seal: sealed.seal,
      canonical: sealed.canonical,
      body,
      credential: shadow,
      ledgerPosting,
    };
    this.mirrors.set(key, record);
    return record;
  }

  public list(): readonly SealedMirror[] {
    return [...this.mirrors.values()];
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
