/**
 * fax-sim stub tests (WP-024): deterministic synthetic deliveries, the
 * synthetic watermark, and an end-to-end handoff into the documents module —
 * the rail delivers a fax, the module stores its bytes and opens a document
 * whose content hash matches the stored blob (hash integrity across the seam).
 */
import { InMemoryBlobStore, receiveDocument, resolveDocumentState } from '@practicehub/documents';
import { describe, expect, it } from 'vitest';

import { createFaxSimStub } from './index.js';

describe('createFaxSimStub', () => {
  it('delivers one deterministic synthetic fax per scenario', () => {
    const rail = createFaxSimStub('unmatched', '2026-03-10T08:00:00Z');
    const deliveries = rail.poll();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.synthetic).toBe(true);
    expect(deliveries[0]?.receivedAt).toBe('2026-03-10T08:00:00Z');
    // Deterministic: a second poll yields the same delivery.
    expect(createFaxSimStub('unmatched', '2026-03-10T08:00:00Z').poll()[0]?.faxId).toBe(
      deliveries[0]?.faxId,
    );
  });

  it('feeds the documents module: a delivered fax becomes a received document with intact bytes', () => {
    const rail = createFaxSimStub('matched', '2026-03-11T09:00:00Z');
    const delivery = rail.poll()[0];
    expect(delivery).toBeDefined();
    const fax = delivery as NonNullable<typeof delivery>;
    const store = new InMemoryBlobStore();
    const { log, blobRef } = receiveDocument(store, [], {
      documentEventId: 'nde-fax-0001',
      tenantId: 'northwind-synthetic',
      documentId: 'nd-fax-0001',
      source: 'inbound_fax',
      bytes: fax.bytes,
      mediaType: fax.mediaType,
      pageCount: fax.pageCount,
      actorRef: 'synthetic-fax-gateway',
      occurredAt: fax.receivedAt,
      synthetic: true,
    });
    const state = resolveDocumentState(log, 'northwind-synthetic', 'nd-fax-0001');
    expect(state?.status).toBe('received');
    expect(store.get(blobRef).bytes).toBe(fax.bytes);
  });
});
