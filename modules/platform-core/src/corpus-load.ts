/**
 * Corpus-load request contract (WP-029). Contract:
 * docs/contracts/synthgen-corpus-api.md (FROZEN) §7.
 *
 * Loading a synthetic corpus WRITES tenant data — persons, households,
 * crosswalk identifiers. That is an authority-bearing act, so it moves under
 * `platform.synthetic-corpus`. The generator itself lives in `tools/synthgen`
 * and this module does not import it: platform-core declares the REQUEST the
 * gate decides on, exactly as M07 declares the rail-scenario control port
 * without depending on a simulator (WP-027).
 *
 * `validateCorpusLoadRequest` sits BELOW the registry. A load that is not
 * synthetic-only is refused whatever grant the caller holds — a capability
 * grant can buy activation, never a relaxation of D3's "no real PHI ever
 * touches the local environment". There is no override parameter, because an
 * override is the only way this refusal could be wrong.
 */

const corpusVersionPattern = /^SynthCorpus-v\d+$/;
const recoveryEpochPattern = /^RE-\d{3,}$/;
const checkpointPattern = /^[0-9a-f]{64}$/;

export interface CorpusLoadRequest {
  readonly tenantId: string;
  readonly corpusVersion: string;
  readonly recoveryEpoch: string;
  /** The manifest checkpoint that fences this corpus version. */
  readonly manifestCheckpoint: string;
  /** The only admissible value; the field exists so a violation is nameable. */
  readonly dataPolicy: 'synthetic-only';
  readonly synthetic: true;
}

export class CorpusLoadRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorpusLoadRefusedError';
  }
}

export function validateCorpusLoadRequest(request: CorpusLoadRequest): void {
  if (request.synthetic !== true) {
    throw new CorpusLoadRefusedError(
      'corpus load refused: the request carries no synthetic watermark',
    );
  }
  if (request.dataPolicy !== 'synthetic-only') {
    throw new CorpusLoadRefusedError(
      `corpus load refused: dataPolicy ${JSON.stringify(request.dataPolicy)} is not ` +
        'synthetic-only — no grant relaxes this',
    );
  }
  if (request.tenantId.length === 0) {
    throw new CorpusLoadRefusedError('corpus load refused: a load names its tenant');
  }
  if (!corpusVersionPattern.test(request.corpusVersion)) {
    throw new CorpusLoadRefusedError(
      `corpus load refused: corpusVersion ${JSON.stringify(request.corpusVersion)} is not a ` +
        'pinned SynthCorpus version — tests reference corpus versions, never floating data',
    );
  }
  if (!recoveryEpochPattern.test(request.recoveryEpoch)) {
    throw new CorpusLoadRefusedError(
      `corpus load refused: recoveryEpoch ${JSON.stringify(request.recoveryEpoch)} is not an ` +
        'RE-NNN ordinal — a restore lands inside a named epoch',
    );
  }
  if (!checkpointPattern.test(request.manifestCheckpoint)) {
    throw new CorpusLoadRefusedError(
      'corpus load refused: the request carries no verifiable manifest checkpoint — ' +
        'an unfenced corpus is not loadable',
    );
  }
}
