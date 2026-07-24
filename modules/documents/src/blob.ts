/**
 * Content-addressed blob store (WP-024, M06). Contract:
 * docs/contracts/blob-api.md (FROZEN). Document bytes never live in Postgres —
 * the metadata tables carry a `blob://` ref plus the sha-256 content hash as the
 * integrity anchor, and the bytes live in the object store (MinIO in the live
 * stack; an in-memory content-addressed store here at the `scaffolded` ceiling).
 *
 * Content-addressing is the integrity mechanism: a blob's key IS the sha-256 of
 * its bytes, so `put` of identical bytes yields an identical ref (natural
 * dedup), and `get` recomputes the hash of what it read and refuses to return
 * bytes whose hash no longer matches the ref — silent corruption is
 * unrepresentable. The MinIO-backed adapter that persists these bytes past
 * process lifetime is FORWARD (FWD-DOC-024-MINIO); the port is frozen here so
 * the module and every test bind the same surface.
 */

import { createHash } from 'node:crypto';

/** The single synthetic bucket at this capability state. */
export const blobBucket = 'documents';

const refPattern = /^blob:\/\/[a-z0-9][a-z0-9-]{0,62}\/[0-9a-f]{64}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

export class BlobStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BlobStoreError';
  }
}

/** Thrown when stored bytes no longer hash to the ref that names them. */
export class BlobIntegrityError extends BlobStoreError {
  public constructor(message: string) {
    super(message);
    this.name = 'BlobIntegrityError';
  }
}

export interface BlobPutInput {
  /** Synthetic UTF-8 content. Real deployments stream bytes; the stub holds a string. */
  readonly bytes: string;
  readonly mediaType: string;
  readonly synthetic: true;
}

export interface BlobStat {
  readonly ref: string;
  readonly contentHash: string;
  readonly contentBytes: number;
  readonly mediaType: string;
}

export interface BlobObject extends BlobStat {
  readonly bytes: string;
}

/** The frozen object-store port every document consumer binds. */
export interface BlobStore {
  put(input: BlobPutInput): BlobStat;
  get(ref: string): BlobObject;
  has(ref: string): boolean;
}

/** sha-256 hex of a UTF-8 string — the content address and the integrity anchor. */
export function hashContent(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/** Byte length of the UTF-8 content. */
export function contentByteLength(bytes: string): number {
  return Buffer.byteLength(bytes, 'utf8');
}

/** Build the content-addressed ref for a hash. */
export function blobRefFor(contentHash: string): string {
  if (!sha256Pattern.test(contentHash)) {
    throw new BlobStoreError(
      `content hash must be sha-256 hex; received ${JSON.stringify(contentHash)}`,
    );
  }
  return `blob://${blobBucket}/${contentHash}`;
}

/** Extract the content hash a ref names (its content address). */
export function hashFromRef(ref: string): string {
  if (!refPattern.test(ref)) {
    throw new BlobStoreError(`not a blob ref: ${JSON.stringify(ref)}`);
  }
  return ref.slice(ref.lastIndexOf('/') + 1);
}

export function isBlobRef(value: string): boolean {
  return refPattern.test(value);
}

/**
 * Deterministic in-memory content-addressed store. Every `get` re-hashes the
 * bytes it holds and refuses to return them if the hash drifted from the ref —
 * the hash-integrity gate is structural, not a test assertion bolted on top.
 */
export class InMemoryBlobStore implements BlobStore {
  private readonly bytesByHash = new Map<string, { bytes: string; mediaType: string }>();

  public put(input: BlobPutInput): BlobStat {
    if (input.synthetic !== true) {
      throw new BlobStoreError('the blob store accepts synthetic content only');
    }
    const contentHash = hashContent(input.bytes);
    // Content-addressed: identical bytes collapse to one object (dedup).
    this.bytesByHash.set(contentHash, { bytes: input.bytes, mediaType: input.mediaType });
    return {
      ref: blobRefFor(contentHash),
      contentHash,
      contentBytes: contentByteLength(input.bytes),
      mediaType: input.mediaType,
    };
  }

  public has(ref: string): boolean {
    return this.bytesByHash.has(hashFromRef(ref));
  }

  public get(ref: string): BlobObject {
    const contentHash = hashFromRef(ref);
    const stored = this.bytesByHash.get(contentHash);
    if (stored === undefined) {
      throw new BlobStoreError(`no blob at ${ref}`);
    }
    const actualHash = hashContent(stored.bytes);
    if (actualHash !== contentHash) {
      throw new BlobIntegrityError(
        `blob integrity failure at ${ref}: stored bytes hash to ${actualHash}`,
      );
    }
    return {
      ref,
      contentHash,
      contentBytes: contentByteLength(stored.bytes),
      mediaType: stored.mediaType,
      bytes: stored.bytes,
    };
  }

  /**
   * Test-only corruption hook: overwrite the bytes under a hash WITHOUT
   * re-addressing, so the next `get` detects the drift. Never a production
   * path — corruption in the field comes from the storage layer, this
   * reproduces its signature deterministically.
   */
  public corruptForTest(ref: string, replacementBytes: string): void {
    const contentHash = hashFromRef(ref);
    const stored = this.bytesByHash.get(contentHash);
    if (stored === undefined) {
      throw new BlobStoreError(`no blob at ${ref}`);
    }
    this.bytesByHash.set(contentHash, { bytes: replacementBytes, mediaType: stored.mediaType });
  }
}

/**
 * Verify a blob against an expected hash without trusting the store's own
 * bookkeeping — the caller supplies the hash it recorded in Postgres, and this
 * re-derives it from the bytes. Used by the intake integrity check and the DB
 * suite's tamper proof.
 */
export function verifyBlobIntegrity(store: BlobStore, ref: string, expectedHash: string): boolean {
  if (!sha256Pattern.test(expectedHash)) {
    throw new BlobStoreError('expected hash must be sha-256 hex');
  }
  const object = store.get(ref);
  return object.contentHash === expectedHash && hashContent(object.bytes) === expectedHash;
}
