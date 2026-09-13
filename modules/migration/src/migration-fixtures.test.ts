import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cloneTemplateForSource, validateMappingForManifest } from './mapping.js';
import { planBatchRollback } from './rollback.js';
import type { MappingVersion, SourceManifest } from './types.js';
import { evaluateFailureThreshold } from './validation.js';

const fixtureDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));
const fixtureClasses = ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const;
const acceptedOps = [
  'template-clone',
  'threshold',
  'threshold-error',
  'source-mapping-refusal',
  'rollback-hold',
] as const;

type FixtureClass = (typeof fixtureClasses)[number];
type FixtureOp = (typeof acceptedOps)[number];

interface FixtureCase {
  readonly name: string;
  readonly op: FixtureOp;
  readonly failed?: number;
  readonly total?: number | null;
  readonly previouslyBlocked?: boolean;
  readonly expectedState?: string;
  readonly expectedStatus?: string;
  readonly expectedError?: string;
  readonly expectedAction?: string;
}

interface FixtureFile {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: FixtureClass;
  readonly cases: readonly FixtureCase[];
}

function load(requirementId: string, fixtureClass: FixtureClass): FixtureFile {
  const path = `${fixtureDirectory}/${requirementId}.${fixtureClass}.json`;
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureFile;
}

const tenant = 'northwind-synthetic';
const template: MappingVersion = {
  tenantId: tenant,
  sourceSystemRef: 'legacy-a',
  mappingVersionRef: 'mapping:a',
  mappingVersionHash: 'a'.repeat(64),
  status: 'approved',
  approvedBy: 'staff:owner',
  approvalEvidenceRef: 'evidence:approval',
  rules: [
    {
      sourceField: 'patient-id',
      disposition: 'mapped',
      targetField: 'person.source-id',
      dataClassification: 'demographic',
    },
  ],
  synthetic: true,
};

function runCase(fixtureCase: FixtureCase): void {
  switch (fixtureCase.op) {
    case 'template-clone': {
      const clone = cloneTemplateForSource(
        template,
        tenant,
        'legacy-b',
        'mapping:b',
        'b'.repeat(64),
      );
      expect(clone.status).toBe(fixtureCase.expectedStatus);
      break;
    }
    case 'threshold': {
      const result = evaluateFailureThreshold({
        failedRecordCount: fixtureCase.failed as number,
        inScopeRecordCount: fixtureCase.total as number,
        thresholdBasisPoints: 500,
        previouslyThresholdBlocked: fixtureCase.previouslyBlocked as boolean,
      });
      expect(result.state).toBe(fixtureCase.expectedState);
      break;
    }
    case 'threshold-error': {
      expect(() =>
        evaluateFailureThreshold({
          failedRecordCount: fixtureCase.failed as number,
          inScopeRecordCount: fixtureCase.total ?? null,
          thresholdBasisPoints: 500,
          previouslyThresholdBlocked: fixtureCase.previouslyBlocked as boolean,
        }),
      ).toThrow(fixtureCase.expectedError);
      break;
    }
    case 'source-mapping-refusal': {
      const manifest: SourceManifest = {
        tenantId: tenant,
        sourceSystemRef: 'legacy-b',
        sourceManifestRef: 'manifest:b',
        sourceManifestHash: 'c'.repeat(64),
        structurallyReadable: true,
        inScopeRecordRefs: ['record-1'],
        sourceFields: ['patient-id'],
        synthetic: true,
      };
      expect(() => validateMappingForManifest(template, manifest)).toThrow(
        fixtureCase.expectedError,
      );
      break;
    }
    case 'rollback-hold': {
      const result = planBatchRollback(tenant, 'batch-1', [
        {
          tenantId: tenant,
          batchRef: 'batch-1',
          recordRef: 'record-1',
          sourceRecordRef: 'source-1',
          batchChanged: true,
          userTouchedAfterBatch: true,
          lastAuthoritativeEventRef: 'event-1',
        },
      ]);
      expect(result[0]?.action).toBe(fixtureCase.expectedAction);
      break;
    }
    default: {
      throw new Error(
        `unrecognized fixture op ${JSON.stringify((fixtureCase as { op: string }).op)}`,
      );
    }
  }
}

for (const requirementId of ['REQ-MIG-012', 'REQ-MIG-013']) {
  describe(`${requirementId} four-class fixture pack`, () => {
    for (const fixtureClass of fixtureClasses) {
      const fixture = load(requirementId, fixtureClass);
      it(`${fixtureClass} is synthetic, nonempty and structurally recognized`, () => {
        expect(fixture.synthetic).toBe(true);
        expect(fixture.requirementId).toBe(requirementId);
        expect(fixture.class).toBe(fixtureClass);
        expect(fixture.cases.length).toBeGreaterThan(0);
        for (const fixtureCase of fixture.cases) {
          expect((acceptedOps as readonly string[]).includes(fixtureCase.op)).toBe(true);
        }
      });
      for (const fixtureCase of fixture.cases) {
        it(`${fixtureClass}: ${fixtureCase.name}`, () => runCase(fixtureCase));
      }
    }
  });
}
