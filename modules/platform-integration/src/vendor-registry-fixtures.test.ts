/**
 * Executable 4-class fixture packs for the WP-026 requirement slice
 * (REQ-PLAT-001/005/029, R6-REQ-008/009/080/081/103). Every case runs against
 * the REAL domain functions — a fixture that merely "exists" without encoding
 * its acceptance criterion cannot pass here. Every egress decision's disclosure
 * audit input is emitted through the REAL @practicehub/audit-evidence emitter,
 * proving each allow AND each block is tamper-evident audit (R6-REQ-001 wiring).
 *
 * Review-009 discipline: the accepted-op list is validated at LOAD (an unknown
 * op fails the pack's structural test, not silently), and the dispatcher ends in
 * a throwing default.
 */
import { fileURLToPath } from 'node:url';

import { emitAuditEvent, emptyChainState } from '@practicehub/audit-evidence';
import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import { evaluateEgress, type EgressRequest } from './egress-guard.js';
import { licenseGate, type ContentLicenseRow } from './content-license.js';
import {
  foldVendorRegistry,
  registryCompleteness,
  validateVendorEvent,
  vendorRow,
  type PhiCategory,
  type VendorRegistryEvent,
  type VendorRegistryRow,
} from './vendor-registry.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));
const tenant = 'northwind-synthetic';

const acceptedOps = ['egress', 'fold', 'completeness', 'license', 'validate-refused'] as const;
type FixtureOp = (typeof acceptedOps)[number];

interface FixtureCase {
  readonly name: string;
  readonly op: FixtureOp;
  // egress
  readonly vendor?: Partial<VendorRegistryRow> | null;
  readonly request?: Partial<EgressRequest>;
  readonly expectAllow?: boolean;
  readonly expectReason?: string;
  readonly expectIncident?: boolean;
  readonly expectAuditDecision?: 'allow' | 'deny';
  readonly expectPartitionTags?: readonly string[];
  // fold
  readonly events?: readonly VendorRegistryEvent[];
  readonly vendorId?: string;
  readonly expectStatus?: string;
  readonly expectBaaStatus?: string;
  readonly expectCategories?: readonly PhiCategory[];
  // completeness
  readonly phiPathVendorIds?: readonly string[];
  readonly asOf?: string;
  readonly expectComplete?: boolean;
  readonly expectIncomplete?: readonly string[];
  // license
  readonly license?: Partial<ContentLicenseRow> | null;
  readonly contentFamily?: ContentLicenseRow['contentFamily'];
  readonly expectedChecksum?: string;
  readonly expectPermitted?: boolean;
  readonly expectLicenseReason?: string;
  // validate-refused
  readonly event?: VendorRegistryEvent;
  readonly expectError?: string;
}

interface VendorFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly cases: readonly FixtureCase[];
}

function buildVendor(overrides: Partial<VendorRegistryRow>): VendorRegistryRow {
  return {
    tenantId: tenant,
    vendorId: 'synthetic-vendor',
    vendorClass: 'cpaas',
    isAiVendor: false,
    enforcementPoint: 'message-send-boundary',
    baaStatus: 'executed',
    baaEffective: '2026-01-01',
    baaExpiry: '2027-01-01',
    noTrainingOnPhi: false,
    zeroRetention: false,
    permittedCategories: ['ID', 'CLIN'],
    status: 'active',
    version: 2,
    synthetic: true,
    ...overrides,
  };
}

function buildRequest(overrides: Partial<EgressRequest>): EgressRequest {
  return {
    tenantId: tenant,
    vendorId: 'synthetic-vendor',
    phiClass: 'PHI',
    categories: ['ID', 'CLIN'],
    purpose: 'treatment',
    asOf: '2026-06-01',
    actorRef: 'synthetic-staff:fixture',
    occurredAt: '2026-06-01T09:00:00Z',
    ...overrides,
  };
}

function buildLicense(overrides: Partial<ContentLicenseRow>): ContentLicenseRow {
  return {
    tenantId: tenant,
    licenseId: 'synthetic-license',
    contentFamily: 'cpt',
    status: 'active',
    effective: '2026-01-01',
    expiry: '2027-01-01',
    rightsRef: 'synthetic-license:fixture',
    checksum: 'a'.repeat(64),
    synthetic: true,
    ...overrides,
  };
}

function runCase(fixtureCase: FixtureCase): void {
  switch (fixtureCase.op) {
    case 'egress': {
      const row = fixtureCase.vendor === null ? null : buildVendor(fixtureCase.vendor ?? {});
      const decision = evaluateEgress(row, buildRequest(fixtureCase.request ?? {}));
      if (fixtureCase.expectAllow !== undefined) {
        expect(decision.allow).toBe(fixtureCase.expectAllow);
      }
      if (fixtureCase.expectReason !== undefined) {
        expect(decision.reason).toBe(fixtureCase.expectReason);
      }
      if (fixtureCase.expectIncident !== undefined) {
        expect(decision.incidentOpened).toBe(fixtureCase.expectIncident);
      }
      if (fixtureCase.expectPartitionTags !== undefined) {
        expect(decision.auditInput.partitionTags ?? []).toEqual(fixtureCase.expectPartitionTags);
      }
      const emitted = emitAuditEvent(emptyChainState, {
        ...decision.auditInput,
        auditId: 'fx-egress-audit-0001',
      });
      expect(emitted.record.entryHash).toMatch(/^[0-9a-f]{64}$/);
      if (fixtureCase.expectAuditDecision !== undefined) {
        expect(emitted.record.decision).toBe(fixtureCase.expectAuditDecision);
      }
      break;
    }
    case 'fold': {
      const rows = foldVendorRegistry(fixtureCase.events ?? []);
      const row = vendorRow(rows, tenant, fixtureCase.vendorId ?? 'synthetic-vendor');
      if (fixtureCase.expectStatus !== undefined) {
        expect(row?.status).toBe(fixtureCase.expectStatus);
      }
      if (fixtureCase.expectBaaStatus !== undefined) {
        expect(row?.baaStatus).toBe(fixtureCase.expectBaaStatus);
      }
      if (fixtureCase.expectCategories !== undefined) {
        expect(row?.permittedCategories).toEqual(fixtureCase.expectCategories);
      }
      break;
    }
    case 'completeness': {
      const rows = foldVendorRegistry(fixtureCase.events ?? []);
      const result = registryCompleteness(
        rows,
        fixtureCase.phiPathVendorIds ?? [],
        tenant,
        fixtureCase.asOf ?? '2026-06-01',
      );
      if (fixtureCase.expectComplete !== undefined) {
        expect(result.complete).toBe(fixtureCase.expectComplete);
      }
      if (fixtureCase.expectIncomplete !== undefined) {
        expect(result.incomplete).toEqual(fixtureCase.expectIncomplete);
      }
      break;
    }
    case 'license': {
      const row = fixtureCase.license === null ? null : buildLicense(fixtureCase.license ?? {});
      const decision = licenseGate(row, {
        contentFamily: fixtureCase.contentFamily ?? 'cpt',
        asOf: fixtureCase.asOf ?? '2026-06-01',
        ...(fixtureCase.expectedChecksum !== undefined
          ? { expectedChecksum: fixtureCase.expectedChecksum }
          : {}),
      });
      if (fixtureCase.expectPermitted !== undefined) {
        expect(decision.permitted).toBe(fixtureCase.expectPermitted);
      }
      if (fixtureCase.expectLicenseReason !== undefined) {
        expect(decision.reason).toBe(fixtureCase.expectLicenseReason);
      }
      break;
    }
    case 'validate-refused': {
      expect(() => validateVendorEvent(fixtureCase.event as VendorRegistryEvent)).toThrow(
        fixtureCase.expectError,
      );
      break;
    }
    default: {
      throw new Error(
        `unrecognized fixture op ${JSON.stringify((fixtureCase as { op: string }).op)} — ` +
          'the dispatcher refuses unknown cases (review-009)',
      );
    }
  }
}

const ownedRequirements = [
  'REQ-PLAT-001',
  'REQ-PLAT-005',
  'REQ-PLAT-029',
  'R6-REQ-008',
  'R6-REQ-009',
  'R6-REQ-080',
  'R6-REQ-081',
  'R6-REQ-103',
];

for (const requirementId of ownedRequirements) {
  describe(`${requirementId} fixture pack (4-class floor)`, () => {
    const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);

    it('carries all four fixture classes with the synthetic watermark', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
    });

    it('every case declares a recognized op (load-time validation, review-009)', () => {
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as unknown as VendorFixture;
        expect(fixture.cases.length).toBeGreaterThan(0);
        for (const fixtureCase of fixture.cases) {
          expect(
            (acceptedOps as readonly string[]).includes(fixtureCase.op),
            `${fixtureClass}: unknown op ${JSON.stringify(fixtureCase.op)}`,
          ).toBe(true);
        }
      }
    });

    for (const fixtureClass of requiredFixtureClasses) {
      describe(fixtureClass, () => {
        const fixture = pack.fixtures[fixtureClass] as unknown as VendorFixture;
        for (const fixtureCase of fixture.cases) {
          it(fixtureCase.name, () => {
            runCase(fixtureCase);
          });
        }
      });
    }
  });
}
