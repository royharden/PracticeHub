import { validateMappingForManifest } from './mapping.js';
import { findingCategories, findingTriages } from './types.js';
import type {
  DryRunEvidence,
  DryRunReport,
  MappingVersion,
  SourceManifest,
  ValidationFinding,
  ValidationRunRef,
  WorkbenchContext,
} from './types.js';
import type {
  IdentityCandidatePort,
  SourceControlTotalPort,
  SourceSnapshotPort,
  TargetDryRunPort,
  WorkItemDirective,
  ValidationRunHistoryPort,
} from './ports.js';
import { reconcileControlTotals } from './reconciliation.js';

export class MigrationValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MigrationValidationError';
  }
}

const evidenceRefPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;

function assertEvidence(evidence: DryRunEvidence): void {
  const refs = [
    evidence.codeVersionRef,
    evidence.configVersionRef,
    ...evidence.sampleEvidenceRefs,
    ...evidence.signoffRefs,
  ];
  if (refs.some((ref) => !evidenceRefPattern.test(ref))) {
    throw new MigrationValidationError('dry-run evidence contains a blank or invalid reference');
  }
  if (!Number.isSafeInteger(evidence.runtimeMilliseconds) || evidence.runtimeMilliseconds < 0) {
    throw new MigrationValidationError('dry-run evidence runtime must be a nonnegative integer');
  }
}

function immutableSnapshot<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object' || Object.isFrozen(candidate)) return;
    for (const nested of Object.values(candidate)) freeze(nested);
    Object.freeze(candidate);
  };
  freeze(clone);
  return clone;
}

export interface ThresholdInput {
  readonly failedRecordCount: number;
  readonly inScopeRecordCount: number | null;
  readonly thresholdBasisPoints: number;
  readonly previouslyThresholdBlocked: boolean;
}

export interface ThresholdDecision {
  readonly state: 'clear' | 'blocked' | 'held-until-below';
  readonly comparison: 'below' | 'equal' | 'above';
}

export function evaluateFailureThreshold(input: ThresholdInput): ThresholdDecision {
  const { failedRecordCount, inScopeRecordCount, thresholdBasisPoints } = input;
  if (
    inScopeRecordCount === null ||
    !Number.isSafeInteger(inScopeRecordCount) ||
    inScopeRecordCount <= 0
  ) {
    throw new MigrationValidationError('in-scope record denominator is zero or unknown');
  }
  if (
    !Number.isSafeInteger(failedRecordCount) ||
    failedRecordCount < 0 ||
    failedRecordCount > inScopeRecordCount
  ) {
    throw new MigrationValidationError('failed-record numerator is invalid');
  }
  if (
    !Number.isSafeInteger(thresholdBasisPoints) ||
    thresholdBasisPoints < 0 ||
    thresholdBasisPoints > 10000
  ) {
    throw new MigrationValidationError('threshold basis points are invalid');
  }

  const left = BigInt(failedRecordCount) * 10000n;
  const right = BigInt(inScopeRecordCount) * BigInt(thresholdBasisPoints);
  const comparison = left < right ? 'below' : left === right ? 'equal' : 'above';
  if (input.previouslyThresholdBlocked) {
    return comparison === 'below'
      ? { state: 'clear', comparison }
      : { state: 'held-until-below', comparison };
  }
  return comparison === 'above' ? { state: 'blocked', comparison } : { state: 'clear', comparison };
}

const unconditionalBlockers = new Set<ValidationFinding['category']>([
  'file-structural-error',
  'genetic-misclassification',
  'payer-panel-unmapped',
  'identity-ambiguity',
]);

function assertFinding(
  finding: ValidationFinding,
  tenantId: string,
  manifest: SourceManifest,
): void {
  if (finding.synthetic !== true) {
    throw new MigrationValidationError('validation finding lacks the synthetic watermark');
  }
  if (!evidenceRefPattern.test(finding.findingRef)) {
    throw new MigrationValidationError('validation finding has an invalid stable identity');
  }
  if (!(findingCategories as readonly unknown[]).includes(finding.category)) {
    throw new MigrationValidationError('validation finding has an unknown category');
  }
  if (!(findingTriages as readonly unknown[]).includes(finding.triage)) {
    throw new MigrationValidationError('validation finding has an unknown triage');
  }
  if (finding.tenantId !== tenantId) {
    throw new MigrationValidationError('validation finding crossed tenant scope');
  }
  if (finding.recordRef !== undefined && !manifest.inScopeRecordRefs.includes(finding.recordRef)) {
    throw new MigrationValidationError(
      `finding ${finding.findingRef} names an out-of-scope record`,
    );
  }
  if (finding.recordRef !== undefined && !evidenceRefPattern.test(finding.recordRef)) {
    throw new MigrationValidationError('validation finding has an invalid record reference');
  }
  if (finding.mappingRuleRef !== undefined && !evidenceRefPattern.test(finding.mappingRuleRef)) {
    throw new MigrationValidationError('validation finding has an invalid mapping-rule reference');
  }
  if (
    (finding.category === 'file-structural-error' && finding.recordRef !== undefined) ||
    (finding.category !== 'file-structural-error' && finding.recordRef === undefined)
  ) {
    throw new MigrationValidationError(
      'validation finding has an invalid file-versus-record shape',
    );
  }
  if (finding.observedAttributeNames.some((name) => !/^[a-z][a-z0-9-]{0,63}$/.test(name))) {
    throw new MigrationValidationError(
      `finding ${finding.findingRef} carries an unsafe attribute name`,
    );
  }
}

export interface RunDryRunInput {
  readonly context: WorkbenchContext;
  readonly runRef: ValidationRunRef;
  readonly manifestRef: string;
  readonly mapping: MappingVersion;
  readonly thresholdBasisPoints: number;
  readonly evidence: DryRunEvidence;
}

export interface DryRunPorts {
  readonly source: SourceSnapshotPort;
  readonly target: TargetDryRunPort;
  readonly identity: IdentityCandidatePort;
  readonly sourceTotals: SourceControlTotalPort;
  readonly history: ValidationRunHistoryPort;
}

export function runDryRun(input: RunDryRunInput, ports: DryRunPorts): DryRunReport {
  assertEvidence(input.evidence);
  const openedManifest = ports.source.open(input.context, input.manifestRef);
  if (openedManifest.tenantId !== input.context.tenantId) {
    throw new MigrationValidationError('source manifest crossed tenant scope');
  }
  if (!openedManifest.structurallyReadable) {
    throw new MigrationValidationError(
      'source export is structurally unreadable; no partial report is allowed',
    );
  }
  if (
    openedManifest.inScopeRecordRefs.length === 0 ||
    new Set(openedManifest.inScopeRecordRefs).size !== openedManifest.inScopeRecordRefs.length
  ) {
    throw new MigrationValidationError('source manifest record population is empty or duplicated');
  }
  const manifest = Object.freeze({
    ...openedManifest,
    inScopeRecordRefs: Object.freeze([...openedManifest.inScopeRecordRefs]),
    sourceFields: Object.freeze([...openedManifest.sourceFields]),
  });
  validateMappingForManifest(input.mapping, manifest);

  const target = ports.target.validate(input.context, manifest, input.mapping);
  if (!/^[0-9a-f]{64}$/.test(target.proposedWriteSetHash)) {
    throw new MigrationValidationError('proposed write-set hash must be sha-256');
  }
  const identity = ports.identity.score(input.context, manifest);
  const findings = [...target.findings, ...identity.findings];
  const findingRefs = new Set<string>();
  for (const finding of findings) {
    assertFinding(finding, input.context.tenantId, manifest);
    if (findingRefs.has(finding.findingRef)) {
      throw new MigrationValidationError(
        'validation finding identity is duplicated or conflicting',
      );
    }
    findingRefs.add(finding.findingRef);
  }
  const failedRecordRefs = [
    ...new Set(
      findings.flatMap((finding) => (finding.recordRef === undefined ? [] : [finding.recordRef])),
    ),
  ].sort();
  if (ports.history === undefined) {
    throw new MigrationValidationError('authoritative validation history is required');
  }
  const predecessor = ports.history.loadLatest(input.context, manifest.sourceManifestRef);
  if (
    predecessor !== undefined &&
    (predecessor.tenantId !== input.context.tenantId ||
      predecessor.waveRef !== input.context.waveRef ||
      predecessor.sourceManifestRef !== manifest.sourceManifestRef)
  ) {
    throw new MigrationValidationError('latest predecessor crossed tenant, wave or source scope');
  }
  if (predecessor !== undefined && !evidenceRefPattern.test(predecessor.runRef)) {
    throw new MigrationValidationError('latest predecessor has an invalid stable identity');
  }
  if (
    predecessor !== undefined &&
    predecessor.thresholdBasisPoints !== input.thresholdBasisPoints
  ) {
    throw new MigrationValidationError(
      'threshold policy drift requires a separately approved policy',
    );
  }
  const threshold = evaluateFailureThreshold({
    failedRecordCount: failedRecordRefs.length,
    inScopeRecordCount: manifest.inScopeRecordRefs.length,
    thresholdBasisPoints: input.thresholdBasisPoints,
    previouslyThresholdBlocked: predecessor !== undefined && predecessor.thresholdState !== 'clear',
  });
  const controlTotals = reconcileControlTotals(
    input.context.tenantId,
    ports.sourceTotals.calculate(input.context, manifest),
    target.controlTotals,
  );
  const requiredIdentityKeys = ['ambiguous', 'candidate', 'matched', 'unmatched'];
  const requiredOutcomeKeys = ['created', 'flagged', 'merged', 'updated'];
  if (
    target.keyFieldCompleteness === undefined ||
    target.outcomeCounts === undefined ||
    target.candidateRecordCount === undefined
  ) {
    throw new MigrationValidationError('target dry-run omitted required comparison evidence');
  }
  if (Object.keys(identity.resultCounts).sort().join('|') !== requiredIdentityKeys.join('|')) {
    throw new MigrationValidationError('identity result counts have an invalid shape');
  }
  if (Object.keys(target.outcomeCounts).sort().join('|') !== requiredOutcomeKeys.join('|')) {
    throw new MigrationValidationError('outcome counts have an invalid shape');
  }
  const comparisonCounts = [
    target.candidateRecordCount,
    ...Object.values(target.keyFieldCompleteness).flatMap((value) => [
      value.sourceCompleteCount,
      value.candidateCompleteCount,
    ]),
    ...Object.values(identity.resultCounts),
    ...Object.values(target.outcomeCounts),
  ];
  if (comparisonCounts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new MigrationValidationError('dry-run comparison contains an invalid count');
  }
  for (const [field, counts] of Object.entries(target.keyFieldCompleteness)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(field)) {
      throw new MigrationValidationError('key-field completeness has an invalid field name');
    }
    if (
      counts.sourceCompleteCount > manifest.inScopeRecordRefs.length ||
      counts.candidateCompleteCount > target.candidateRecordCount
    ) {
      throw new MigrationValidationError('key-field completeness exceeds its population');
    }
  }
  const identityPopulation = Object.values(identity.resultCounts).reduce(
    (total, count) => total + count,
    0,
  );
  if (identityPopulation !== manifest.inScopeRecordRefs.length) {
    throw new MigrationValidationError(
      'identity result counts do not partition the source population',
    );
  }
  const blockerCodes = [
    ...(threshold.state === 'clear' ? [] : [`threshold:${threshold.state}`]),
    ...findings
      .filter((finding) => unconditionalBlockers.has(finding.category))
      .map((finding) => `finding:${finding.category}`),
    ...controlTotals
      .filter((total) => total.state === 'blocking')
      .map((total) => `control-total:${total.name}`),
    ...(input.evidence.sampleEvidenceRefs.length === 0 ? ['evidence:samples-missing'] : []),
    ...(input.evidence.signoffRefs.length === 0 ? ['evidence:signoffs-missing'] : []),
    ...(input.evidence.runtimeMilliseconds < 0 ? ['evidence:runtime-invalid'] : []),
  ];
  return immutableSnapshot({
    tenantId: input.context.tenantId,
    waveRef: input.context.waveRef,
    runRef: input.runRef,
    ...(predecessor === undefined
      ? {}
      : {
          predecessorRunRef: predecessor.runRef,
          failedRecordCountChange: failedRecordRefs.length - predecessor.failedRecordCount,
        }),
    sourceManifestRef: manifest.sourceManifestRef,
    sourceManifestHash: manifest.sourceManifestHash,
    mappingVersionRef: input.mapping.mappingVersionRef,
    mappingVersionHash: input.mapping.mappingVersionHash,
    findings,
    failureCountsByCategory: Object.fromEntries(
      findingCategories
        .map(
          (category) =>
            [
              category,
              new Set(
                findings
                  .filter((finding) => finding.category === category)
                  .map((finding) => finding.recordRef ?? `file:${finding.findingRef}`),
              ).size,
            ] as const,
        )
        .filter(([, count]) => count > 0),
    ),
    failedRecordRefs,
    failedRecordCount: failedRecordRefs.length,
    inScopeRecordCount: manifest.inScopeRecordRefs.length,
    thresholdBasisPoints: input.thresholdBasisPoints,
    thresholdState: threshold.state,
    readiness: blockerCodes.length === 0 ? 'ready-for-review' : 'blocked',
    blockerCodes: [...new Set(blockerCodes)].sort(),
    controlTotals,
    comparison: {
      sourceRecordCount: manifest.inScopeRecordRefs.length,
      candidateRecordCount: target.candidateRecordCount,
      keyFieldCompleteness: target.keyFieldCompleteness,
      identityMatchResults: identity.resultCounts,
      outcomeCounts: target.outcomeCounts,
    },
    evidence: input.evidence,
    proposedWriteSetHash: target.proposedWriteSetHash,
    targetDataWrites: 0,
    synthetic: true,
  });
}

export function goNoGoReviewDirective(report: DryRunReport): WorkItemDirective {
  if (report.readiness !== 'ready-for-review') {
    throw new MigrationValidationError('a blocked run cannot create a go/no-go review');
  }
  return {
    tenantId: report.tenantId,
    stableKey: `migration-go-no-go:${report.tenantId}:${report.runRef}`,
    kind: 'migration-go-no-go-review',
    ownerRole: 'data-migration',
    evidenceRefs: [
      report.sourceManifestRef,
      report.mappingVersionRef,
      report.proposedWriteSetHash,
      ...report.evidence.sampleEvidenceRefs,
      ...report.evidence.signoffRefs,
    ],
    deadlinePolicyRef: 'migration-go-no-go-review',
    synthetic: true,
  };
}
