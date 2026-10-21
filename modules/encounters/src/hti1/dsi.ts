/**
 * Predictive decision-support intervention (DSI) source attributes
 * (WP-096; R6-REQ-042). A predictive output renders only with its complete
 * source-attribute panel; a missing attribute suppresses the output instead of
 * rendering it bare. The 14-attribute set follows docs/compliance/compliance-map.md.
 */

export const dsiSourceAttributes = [
  'developer',
  'funding-source',
  'intended-use',
  'intended-patient-population',
  'intended-users',
  'cautioned-out-of-scope-use',
  'known-risks-and-limitations',
  'training-data-description',
  'training-data-demographics',
  'input-features',
  'validation-process',
  'performance-measures',
  'fairness-evaluation',
  'update-and-monitoring',
] as const;
export type DsiSourceAttribute = (typeof dsiSourceAttributes)[number];

export type DsiKind = 'predictive' | 'evidence-based';

export interface DsiRecord {
  readonly dsiRef: string;
  readonly kind: DsiKind;
  readonly modelVersion: string;
  readonly attributes: Readonly<Partial<Record<DsiSourceAttribute, string>>>;
  /** Eval evidence (validation, fairness) from the WP-101 harness; placeholder ref. */
  readonly evalRunRef: string | null;
  readonly synthetic: true;
}

export interface PredictiveOutput {
  readonly dsiRef: string;
  readonly modelVersion: string;
  readonly personId: string;
  readonly summary: string;
  readonly score: number;
}

export interface AttributeLine {
  readonly attribute: DsiSourceAttribute;
  readonly value: string;
}

export type RenderedDsiOutput =
  | {
      readonly status: 'rendered';
      readonly output: PredictiveOutput;
      readonly sourceAttributes: readonly AttributeLine[];
    }
  | { readonly status: 'suppressed'; readonly dsiRef: string; readonly reasons: readonly string[] };

export class DsiCatalogError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DsiCatalogError';
  }
}

export function missingAttributes(record: DsiRecord): readonly DsiSourceAttribute[] {
  return dsiSourceAttributes.filter(
    (attribute) => (record.attributes[attribute] ?? '').trim() === '',
  );
}

export interface DsiSupersession {
  readonly prior: DsiRecord;
  readonly supersededBy: string;
  readonly reason: string;
}

export class DsiCatalog {
  private readonly records = new Map<string, DsiRecord>();
  private readonly history = new Map<string, DsiSupersession[]>();

  /** Registers a new DSI. An existing dsiRef changes only through `supersede`. */
  public register(record: DsiRecord): DsiRecord {
    if (this.records.has(record.dsiRef)) {
      throw new DsiCatalogError(`${record.dsiRef} is registered; use supersede to change it`);
    }
    this.records.set(record.dsiRef, record);
    return record;
  }

  /** Replaces a DSI record (new model version or attributes), keeping the prior one. */
  public supersede(record: DsiRecord, supersededBy: string, reason: string): DsiRecord {
    const prior = this.records.get(record.dsiRef);
    if (prior === undefined) {
      throw new DsiCatalogError(`${record.dsiRef} is not registered`);
    }
    if (supersededBy.trim() === '' || reason.trim() === '') {
      throw new DsiCatalogError('a supersession needs an actor and a reason');
    }
    const log = this.history.get(record.dsiRef) ?? [];
    log.push({ prior, supersededBy, reason });
    this.history.set(record.dsiRef, log);
    this.records.set(record.dsiRef, record);
    return record;
  }

  public historyOf(dsiRef: string): readonly DsiSupersession[] {
    return [...(this.history.get(dsiRef) ?? [])];
  }

  public get(dsiRef: string): DsiRecord | undefined {
    return this.records.get(dsiRef);
  }

  /** Render a predictive output with its source attributes, or suppress it. */
  public render(output: PredictiveOutput): RenderedDsiOutput {
    const record = this.records.get(output.dsiRef);
    if (record === undefined) {
      return { status: 'suppressed', dsiRef: output.dsiRef, reasons: ['unregistered DSI'] };
    }
    const reasons: string[] = [];
    if (record.kind !== 'predictive') {
      reasons.push('output claims a predictive score from a non-predictive DSI');
    }
    if (record.modelVersion !== output.modelVersion) {
      reasons.push(
        `model version ${output.modelVersion} does not match registered ${record.modelVersion}`,
      );
    }
    const missing = missingAttributes(record);
    if (missing.length > 0) {
      reasons.push(`missing source attributes: ${missing.join(', ')}`);
    }
    if (record.evalRunRef === null) {
      reasons.push('no validation evidence (eval run) on record');
    }
    if (reasons.length > 0) {
      return { status: 'suppressed', dsiRef: output.dsiRef, reasons };
    }
    return {
      status: 'rendered',
      output,
      sourceAttributes: dsiSourceAttributes.map((attribute) => ({
        attribute,
        value: record.attributes[attribute] ?? '',
      })),
    };
  }
}
