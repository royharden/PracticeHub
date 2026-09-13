import { describe, expect, it } from 'vitest';

import type { ControlTotal, MappingVersion, SourceManifest, ValidationFinding } from './types.js';
import { evaluateFailureThreshold, goNoGoReviewDirective, runDryRun } from './validation.js';
import {
  FixedSourceControlTotalDouble,
  RecordingIdentityCandidateDouble,
  RecordingTargetDryRunDouble,
  RecordingWorkItemDouble,
  StoredValidationRunHistoryDouble,
  SyntheticSourceSnapshotDouble,
} from './testing/doubles.js';

const tenant = 'northwind-synthetic';
const hash = 'a'.repeat(64);
const context = { tenantId: tenant, legalEntityId: 'le-synthetic', waveRef: 'wave-synthetic' };

function manifest(count = 200): SourceManifest {
  return {
    tenantId: tenant,
    sourceSystemRef: 'legacy-synthetic',
    sourceManifestRef: 'manifest:synthetic-v1',
    sourceManifestHash: hash,
    structurallyReadable: true,
    inScopeRecordRefs: Array.from(
      { length: count },
      (_, index) => `record-${String(index + 1).padStart(3, '0')}`,
    ),
    sourceFields: ['patient-id', 'birth-date'],
    synthetic: true,
  };
}

const mapping: MappingVersion = {
  tenantId: tenant,
  sourceSystemRef: 'legacy-synthetic',
  mappingVersionRef: 'mapping:synthetic-v1',
  mappingVersionHash: 'b'.repeat(64),
  status: 'approved',
  approvedBy: 'staff:migration-owner',
  approvalEvidenceRef: 'evidence:mapping-approval-v1',
  rules: [
    {
      sourceField: 'patient-id',
      disposition: 'mapped',
      targetField: 'person.source-id',
      dataClassification: 'demographic',
    },
    {
      sourceField: 'birth-date',
      disposition: 'mapped',
      targetField: 'person.birth-date',
      dataClassification: 'phi',
    },
  ],
  synthetic: true,
};

function total(side: ControlTotal['side']): ControlTotal {
  return {
    totalRef: `total:${side}:records`,
    tenantId: tenant,
    side,
    name: 'records',
    valueMinor: '200',
    unit: 'records',
    checksum: 'c'.repeat(64),
    synthetic: true,
  };
}

function finding(recordRef: string, suffix = ''): ValidationFinding {
  return {
    findingRef: `finding:${recordRef}${suffix}`,
    tenantId: tenant,
    recordRef,
    category: 'required-field',
    triage: 'needs-source-correction',
    observedAttributeNames: ['birth-date'],
    synthetic: true,
  };
}

const evidence = {
  codeVersionRef: 'code:c540076',
  configVersionRef: 'config:synthetic-v1',
  sampleEvidenceRefs: ['sample:synthetic-v1'],
  runtimeMilliseconds: 42,
  signoffRefs: ['signoff:migration-owner'],
} as const;

describe('failure threshold hysteresis', () => {
  it('separates initial equality from release equality with exact arithmetic', () => {
    expect(
      evaluateFailureThreshold({
        failedRecordCount: 10,
        inScopeRecordCount: 200,
        thresholdBasisPoints: 500,
        previouslyThresholdBlocked: false,
      }),
    ).toEqual({ state: 'clear', comparison: 'equal' });
    expect(
      evaluateFailureThreshold({
        failedRecordCount: 11,
        inScopeRecordCount: 200,
        thresholdBasisPoints: 500,
        previouslyThresholdBlocked: false,
      }),
    ).toEqual({ state: 'blocked', comparison: 'above' });
    expect(
      evaluateFailureThreshold({
        failedRecordCount: 10,
        inScopeRecordCount: 200,
        thresholdBasisPoints: 500,
        previouslyThresholdBlocked: true,
      }),
    ).toEqual({ state: 'held-until-below', comparison: 'equal' });
    expect(
      evaluateFailureThreshold({
        failedRecordCount: 9,
        inScopeRecordCount: 200,
        thresholdBasisPoints: 500,
        previouslyThresholdBlocked: true,
      }),
    ).toEqual({ state: 'clear', comparison: 'below' });
  });

  it('fails closed on zero and unknown denominators', () => {
    expect(() =>
      evaluateFailureThreshold({
        failedRecordCount: 0,
        inScopeRecordCount: 0,
        thresholdBasisPoints: 500,
        previouslyThresholdBlocked: false,
      }),
    ).toThrow('zero or unknown');
    expect(() =>
      evaluateFailureThreshold({
        failedRecordCount: 0,
        inScopeRecordCount: null,
        thresholdBasisPoints: 500,
        previouslyThresholdBlocked: false,
      }),
    ).toThrow('zero or unknown');
  });
});

describe('effect-free dry run', () => {
  it('counts failed records rather than findings and creates one tenant-scoped review directive', () => {
    const records = manifest();
    const findings = [
      finding('record-001'),
      finding('record-001', '-second'),
      ...Array.from({ length: 9 }, (_, index) =>
        finding(`record-${String(index + 2).padStart(3, '0')}`),
      ),
    ];
    const target = new RecordingTargetDryRunDouble({
      findings,
      controlTotals: [total('candidate-target')],
      proposedWriteSetHash: 'd'.repeat(64),
      candidateRecordCount: 190,
      keyFieldCompleteness: {
        'patient-id': { sourceCompleteCount: 200, candidateCompleteCount: 190 },
      },
      outcomeCounts: { created: 190, updated: 0, merged: 0, flagged: 10 },
    });
    const report = runDryRun(
      {
        context,
        runRef: 'run:initial-equality',
        manifestRef: records.sourceManifestRef,
        mapping,
        thresholdBasisPoints: 500,
        evidence,
      },
      {
        source: new SyntheticSourceSnapshotDouble(records),
        target,
        identity: new RecordingIdentityCandidateDouble([], {
          matched: 180,
          candidate: 10,
          ambiguous: 0,
          unmatched: 10,
        }),
        sourceTotals: new FixedSourceControlTotalDouble([total('source')]),
        history: new StoredValidationRunHistoryDouble([]),
      },
    );
    expect(report.findings).toHaveLength(11);
    expect(report.failedRecordCount).toBe(10);
    expect(report.failureCountsByCategory).toEqual({ 'required-field': 10 });
    expect(report.thresholdState).toBe('clear');
    expect(report.targetDataWrites).toBe(0);
    expect(report.sourceManifestHash).toBe(hash);
    expect(report.mappingVersionHash).toBe('b'.repeat(64));
    expect(report.comparison.candidateRecordCount).toBe(190);
    expect(report.comparison.identityMatchResults.candidate).toBe(10);
    expect(target.calls).toBe(1);
    const workItems = new RecordingWorkItemDouble();
    const directive = goNoGoReviewDirective(report);
    expect(directive.tenantId).toBe(tenant);
    expect(workItems.open(directive).created).toBe(true);
    expect(workItems.open(directive).created).toBe(false);
    expect(() =>
      workItems.open({
        ...directive,
        evidenceRefs: [...directive.evidenceRefs, 'evidence:changed'],
      }),
    ).toThrow('changed directive intent');
    expect(workItems.values()).toHaveLength(1);
  });

  it('rejects identity result counts that do not partition the frozen source population', () => {
    const records = manifest();
    expect(() =>
      runDryRun(
        {
          context,
          runRef: 'run:bad-identity-counts',
          manifestRef: records.sourceManifestRef,
          mapping,
          thresholdBasisPoints: 500,
          evidence,
        },
        {
          source: new SyntheticSourceSnapshotDouble(records),
          target: new RecordingTargetDryRunDouble({
            findings: [],
            controlTotals: [total('candidate-target')],
            proposedWriteSetHash: 'd'.repeat(64),
          }),
          identity: new RecordingIdentityCandidateDouble([], {
            matched: 199,
            candidate: 0,
            ambiguous: 0,
            unmatched: 0,
          }),
          sourceTotals: new FixedSourceControlTotalDouble([total('source')]),
          history: new StoredValidationRunHistoryDouble([]),
        },
      ),
    ).toThrow('do not partition');
  });

  it('rejects malformed evidence and missing or invented comparison shapes', () => {
    const records = manifest();
    const ports = {
      source: new SyntheticSourceSnapshotDouble(records),
      target: new RecordingTargetDryRunDouble({
        findings: [],
        controlTotals: [total('candidate-target')],
        proposedWriteSetHash: 'd'.repeat(64),
      }),
      identity: new RecordingIdentityCandidateDouble([]),
      sourceTotals: new FixedSourceControlTotalDouble([total('source')]),
      history: new StoredValidationRunHistoryDouble([]),
    };
    for (const invalidEvidence of [
      { ...evidence, runtimeMilliseconds: Number.NaN },
      { ...evidence, codeVersionRef: '' },
      { ...evidence, sampleEvidenceRefs: [''] },
    ]) {
      expect(() =>
        runDryRun(
          {
            context,
            runRef: 'run:bad-evidence',
            manifestRef: records.sourceManifestRef,
            mapping,
            thresholdBasisPoints: 500,
            evidence: invalidEvidence,
          },
          ports,
        ),
      ).toThrow(/evidence/);
    }
    const malformedPorts = {
      ...ports,
      target: {
        validate: () => ({
          findings: [],
          controlTotals: [total('candidate-target')],
          proposedWriteSetHash: 'd'.repeat(64),
        }),
      },
    } as unknown as Parameters<typeof runDryRun>[1];
    expect(() =>
      runDryRun(
        {
          context,
          runRef: 'run:missing-comparison',
          manifestRef: records.sourceManifestRef,
          mapping,
          thresholdBasisPoints: 500,
          evidence,
        },
        malformedPorts,
      ),
    ).toThrow('omitted required comparison');
    const inventedIdentity = {
      ...ports,
      identity: {
        score: () => ({ findings: [], resultCounts: { invented: 200 } }),
      },
    } as unknown as Parameters<typeof runDryRun>[1];
    expect(() =>
      runDryRun(
        {
          context,
          runRef: 'run:invented-identity',
          manifestRef: records.sourceManifestRef,
          mapping,
          thresholdBasisPoints: 500,
          evidence,
        },
        inventedIdentity,
      ),
    ).toThrow('invalid shape');
  });

  it('loads authoritative predecessor evidence and retains equality until below threshold', () => {
    const records = manifest();
    const predecessor = {
      tenantId: tenant,
      waveRef: context.waveRef,
      runRef: 'run:blocked-predecessor',
      sourceManifestRef: records.sourceManifestRef,
      thresholdBasisPoints: 500,
      thresholdState: 'blocked' as const,
      failedRecordCount: 11,
    };
    const findings = Array.from({ length: 10 }, (_, index) =>
      finding(`record-${String(index + 1).padStart(3, '0')}`),
    );
    const input = {
      context,
      runRef: 'run:held-successor',
      manifestRef: records.sourceManifestRef,
      mapping,
      thresholdBasisPoints: 500,
      evidence,
    } as const;
    const commonPorts = {
      source: new SyntheticSourceSnapshotDouble(records),
      target: new RecordingTargetDryRunDouble({
        findings,
        controlTotals: [total('candidate-target')],
        proposedWriteSetHash: 'd'.repeat(64),
      }),
      identity: new RecordingIdentityCandidateDouble([]),
      sourceTotals: new FixedSourceControlTotalDouble([total('source')]),
      history: new StoredValidationRunHistoryDouble([predecessor]),
    };
    const report = runDryRun(input, commonPorts);
    expect(report.thresholdState).toBe('held-until-below');
    expect(report.predecessorRunRef).toBe(predecessor.runRef);
    expect(report.failedRecordCountChange).toBe(-1);
    expect(() =>
      runDryRun(input, {
        ...commonPorts,
        history: new StoredValidationRunHistoryDouble([
          { ...predecessor, thresholdBasisPoints: 400 },
        ]),
      }),
    ).toThrow('threshold policy drift');
  });

  it('halts an unreadable source before target validation', () => {
    const unreadable = { ...manifest(), structurallyReadable: false };
    const target = new RecordingTargetDryRunDouble({
      findings: [],
      controlTotals: [total('candidate-target')],
      proposedWriteSetHash: 'd'.repeat(64),
    });
    expect(() =>
      runDryRun(
        {
          context,
          runRef: 'run:unreadable',
          manifestRef: unreadable.sourceManifestRef,
          mapping,
          thresholdBasisPoints: 500,
          evidence,
        },
        {
          source: new SyntheticSourceSnapshotDouble(unreadable),
          target,
          identity: new RecordingIdentityCandidateDouble([]),
          sourceTotals: new FixedSourceControlTotalDouble([total('source')]),
          history: new StoredValidationRunHistoryDouble([]),
        },
      ),
    ).toThrow('no partial report');
    expect(target.calls).toBe(0);
  });

  it('rejects duplicate record identities before validation freezes the population', () => {
    const duplicated = { ...manifest(2), inScopeRecordRefs: ['record-001', 'record-001'] };
    const target = new RecordingTargetDryRunDouble({
      findings: [finding('record-001')],
      controlTotals: [total('candidate-target')],
      proposedWriteSetHash: 'd'.repeat(64),
    });
    expect(() =>
      runDryRun(
        {
          context,
          runRef: 'run:duplicate-population',
          manifestRef: duplicated.sourceManifestRef,
          mapping,
          thresholdBasisPoints: 500,
          evidence,
        },
        {
          source: new SyntheticSourceSnapshotDouble(duplicated),
          target,
          identity: new RecordingIdentityCandidateDouble([]),
          sourceTotals: new FixedSourceControlTotalDouble([total('source')]),
          history: new StoredValidationRunHistoryDouble([]),
        },
      ),
    ).toThrow('population is empty or duplicated');
    expect(target.calls).toBe(0);
  });

  it('rejects recordless record findings and malformed runtime discriminator values', () => {
    const records = manifest();
    const malformed = {
      ...finding('record-001'),
      recordRef: undefined,
      category: 'required-field',
    } as unknown as ValidationFinding;
    const invalidCategory = {
      ...finding('record-001'),
      category: 'invented-category',
    } as unknown as ValidationFinding;
    for (const candidate of [malformed, invalidCategory]) {
      expect(() =>
        runDryRun(
          {
            context,
            runRef: 'run:malformed-finding',
            manifestRef: records.sourceManifestRef,
            mapping,
            thresholdBasisPoints: 500,
            evidence,
          },
          {
            source: new SyntheticSourceSnapshotDouble(records),
            target: new RecordingTargetDryRunDouble({
              findings: [candidate],
              controlTotals: [total('candidate-target')],
              proposedWriteSetHash: 'd'.repeat(64),
            }),
            identity: new RecordingIdentityCandidateDouble([]),
            sourceTotals: new FixedSourceControlTotalDouble([total('source')]),
            history: new StoredValidationRunHistoryDouble([]),
          },
        ),
      ).toThrow(/invalid file-versus-record shape|unknown category/);
    }
  });

  it('rejects duplicate finding identities and returns a detached deeply frozen report', () => {
    const records = manifest();
    const duplicate = finding('record-001');
    const targetFindings = [duplicate];
    const target = new RecordingTargetDryRunDouble({
      findings: targetFindings,
      controlTotals: [total('candidate-target')],
      proposedWriteSetHash: 'd'.repeat(64),
    });
    expect(() =>
      runDryRun(
        {
          context,
          runRef: 'run:duplicate-finding',
          manifestRef: records.sourceManifestRef,
          mapping,
          thresholdBasisPoints: 500,
          evidence,
        },
        {
          source: new SyntheticSourceSnapshotDouble(records),
          target,
          identity: new RecordingIdentityCandidateDouble([duplicate]),
          sourceTotals: new FixedSourceControlTotalDouble([total('source')]),
          history: new StoredValidationRunHistoryDouble([]),
        },
      ),
    ).toThrow('duplicated or conflicting');
    const report = runDryRun(
      {
        context,
        runRef: 'run:frozen',
        manifestRef: records.sourceManifestRef,
        mapping,
        thresholdBasisPoints: 500,
        evidence,
      },
      {
        source: new SyntheticSourceSnapshotDouble(records),
        target,
        identity: new RecordingIdentityCandidateDouble([]),
        sourceTotals: new FixedSourceControlTotalDouble([total('source')]),
        history: new StoredValidationRunHistoryDouble([]),
      },
    );
    targetFindings.push(finding('record-002'));
    expect(report.findings).toHaveLength(1);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.findings)).toBe(true);
    expect(Object.isFrozen(report.evidence.sampleEvidenceRefs)).toBe(true);
  });

  it('blocks unconditional safety findings below the percentage threshold', () => {
    const records = manifest();
    const genetic: ValidationFinding = {
      ...finding('record-001'),
      category: 'genetic-misclassification',
    };
    const report = runDryRun(
      {
        context,
        runRef: 'run:genetic',
        manifestRef: records.sourceManifestRef,
        mapping,
        thresholdBasisPoints: 500,
        evidence,
      },
      {
        source: new SyntheticSourceSnapshotDouble(records),
        target: new RecordingTargetDryRunDouble({
          findings: [genetic],
          controlTotals: [total('candidate-target')],
          proposedWriteSetHash: 'd'.repeat(64),
        }),
        identity: new RecordingIdentityCandidateDouble([]),
        sourceTotals: new FixedSourceControlTotalDouble([total('source')]),
        history: new StoredValidationRunHistoryDouble([]),
      },
    );
    expect(report.thresholdState).toBe('clear');
    expect(report.readiness).toBe('blocked');
    expect(report.blockerCodes).toContain('finding:genetic-misclassification');
  });
});
