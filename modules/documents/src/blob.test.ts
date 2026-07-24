/**
 * Blob store hash-integrity gate (WP-024 verification gate: "hash integrity").
 * Content-addressing IS the integrity mechanism — the ref is the sha-256 of the
 * bytes, so corruption is detected on read, not trusted away.
 */
import { describe, expect, it } from 'vitest';

import {
  BlobIntegrityError,
  BlobStoreError,
  InMemoryBlobStore,
  blobRefFor,
  hashContent,
  hashFromRef,
  isBlobRef,
  verifyBlobIntegrity,
} from './blob.js';

const content = 'synthetic-document-bytes:test:page-1';

describe('content-addressed blob store', () => {
  it('put returns a content-addressed ref whose hash is the sha-256 of the bytes', () => {
    const store = new InMemoryBlobStore();
    const stat = store.put({ bytes: content, mediaType: 'application/pdf', synthetic: true });
    expect(stat.contentHash).toBe(hashContent(content));
    expect(stat.ref).toBe(blobRefFor(hashContent(content)));
    expect(hashFromRef(stat.ref)).toBe(stat.contentHash);
    expect(isBlobRef(stat.ref)).toBe(true);
    expect(stat.contentBytes).toBeGreaterThan(0);
  });

  it('get round-trips the exact bytes', () => {
    const store = new InMemoryBlobStore();
    const { ref } = store.put({ bytes: content, mediaType: 'application/pdf', synthetic: true });
    expect(store.get(ref).bytes).toBe(content);
  });

  it('identical bytes collapse to one content address (natural dedup)', () => {
    const store = new InMemoryBlobStore();
    const a = store.put({ bytes: content, mediaType: 'application/pdf', synthetic: true });
    const b = store.put({ bytes: content, mediaType: 'image/tiff', synthetic: true });
    expect(a.ref).toBe(b.ref);
  });

  it('detects corruption: bytes that no longer hash to their ref are refused on read', () => {
    const store = new InMemoryBlobStore();
    const { ref } = store.put({ bytes: content, mediaType: 'application/pdf', synthetic: true });
    store.corruptForTest(ref, 'synthetic-tampered-bytes');
    expect(() => store.get(ref)).toThrow(BlobIntegrityError);
  });

  it('verifyBlobIntegrity confirms an intact blob against its recorded hash', () => {
    const store = new InMemoryBlobStore();
    const { ref, contentHash } = store.put({
      bytes: content,
      mediaType: 'application/pdf',
      synthetic: true,
    });
    expect(verifyBlobIntegrity(store, ref, contentHash)).toBe(true);
  });

  it('a mismatched expected hash fails verification without trusting the store', () => {
    const store = new InMemoryBlobStore();
    const { ref } = store.put({ bytes: content, mediaType: 'application/pdf', synthetic: true });
    const otherHash = hashContent('synthetic-other-bytes');
    expect(verifyBlobIntegrity(store, ref, otherHash)).toBe(false);
  });

  it('refuses non-synthetic content and reads of an absent object', () => {
    const store = new InMemoryBlobStore();
    expect(() =>
      store.put({
        bytes: content,
        mediaType: 'application/pdf',
        synthetic: false as unknown as true,
      }),
    ).toThrow(BlobStoreError);
    expect(() => store.get(blobRefFor(hashContent('synthetic-absent')))).toThrow(BlobStoreError);
  });

  it('rejects a malformed ref', () => {
    expect(() => hashFromRef('not-a-blob-ref')).toThrow(BlobStoreError);
    expect(isBlobRef('blob://documents/short')).toBe(false);
  });
});
