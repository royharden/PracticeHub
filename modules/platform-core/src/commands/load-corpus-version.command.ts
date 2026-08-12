/**
 * Corpus-load command (WP-029). Contract: docs/contracts/synthgen-corpus-api.md
 * (FROZEN) §7.
 *
 * Loading a corpus version into a tenant writes person-shaped data, so it is
 * gated at `platform.synthetic-corpus` and floors at `simulated`. WP-029 seeds
 * the capability at `scaffolded` — the package ceiling — so the seeded local
 * grant DENIES a live load by design; walking it further belongs to whichever
 * package takes corpus loading into a reference loop.
 *
 * Two independent refusals guard the same act: `validateCorpusLoadRequest`
 * refuses anything that is not synthetic-only (below the registry, no override
 * path), and the capability gate decides who may load at all. Reading a corpus
 * and the ROLLBACK direction (dropping a corpus version) are never gated — a
 * rollback must always be available, the audit.emit precedent.
 */

import { defineCommandHandler } from '../commands.js';
import { validateCorpusLoadRequest, type CorpusLoadRequest } from '../corpus-load.js';

export interface LoadCorpusVersionCommandInput {
  readonly request: CorpusLoadRequest;
}

export const loadCorpusVersionCommand = defineCommandHandler<
  LoadCorpusVersionCommandInput,
  CorpusLoadRequest
>({
  capabilityId: 'platform.synthetic-corpus',
  minimumState: 'simulated',
  handle: (_context, input) => {
    validateCorpusLoadRequest(input.request);
    return input.request;
  },
});
