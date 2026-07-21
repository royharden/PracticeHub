/**
 * Executable 4-class fixture packs for the WP-013 requirement slice
 * (REQ-ID-003/004/005/015/017). Every case runs against the real domain
 * functions — a fixture that merely "exists" without encoding its acceptance
 * criterion cannot pass here.
 */
import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import {
  assertOpaqueExternalReference,
  linkSourceIdentifier,
  recordBuyerConversion,
  resolvePersonBySourceId,
  type BuyerConversionAttribution,
  type SourceIdentifier,
} from './crosswalk.js';
import {
  disputeEndpointOwnership,
  personsSharingEndpoint,
  resolveOutreachIdentity,
  type EndpointAssociation,
  type EndpointOwnershipDispute,
} from './endpoints.js';
import { reconcileDemographics } from './identity.js';
import {
  assertMergeAuthorizationBasis,
  registerIdentityInquiry,
  type IdentityInquiry,
  type IdentityInquiryOptions,
  type MatchablePerson,
  type MergeAuthorizationBasis,
} from './matching.js';
import {
  nameForContext,
  outstandingNameAcknowledgments,
  routeExternalNameRejection,
  type NameContext,
  type PersonName,
} from './names.js';
import { appendTimelineEntry, type IdentityTimelineEntry } from './timeline.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));

interface FixtureCase {
  readonly name: string;
  readonly op:
    | 'register'
    | 'merge-basis'
    | 'link-source'
    | 'resolve-source'
    | 'opaque-ref'
    | 'conversion'
    | 'name-render'
    | 'name-rejection'
    | 'name-acks'
    | 'endpoint-persons'
    | 'outreach'
    | 'dispute'
    | 'reconcile'
    | 'timeline-append';
  readonly inquiry?: IdentityInquiry;
  readonly options?: IdentityInquiryOptions;
  readonly expectOutcome?: string;
  readonly expectCandidateCount?: number;
  readonly expectMatchedAttributes?: readonly string[];
  readonly expectStrong?: boolean;
  readonly expectSerializedExcludes?: readonly string[];
  readonly basis?: MergeAuthorizationBasis;
  readonly expectError?: string;
  readonly link?: SourceIdentifier;
  readonly system?: string;
  readonly value?: string;
  readonly expectPersonId?: string | null;
  readonly personId?: string;
  readonly attribution?: BuyerConversionAttribution;
  readonly context?: NameContext;
  readonly expectKindUsed?: string;
  readonly expectGivenName?: string;
  readonly expectLegalIdentifierRequired?: boolean;
  readonly rejectionRef?: string;
  readonly requiredSystems?: readonly string[];
  readonly acknowledgedSystems?: readonly string[];
  readonly expectOutstanding?: readonly string[];
  readonly endpointId?: string;
  readonly expectPersonIds?: readonly string[];
  readonly expectKind?: string;
  readonly dispute?: EndpointOwnershipDispute;
  readonly expectSuppress?: readonly string[];
  readonly current?: Record<string, string>;
  readonly incoming?: Record<string, string>;
  readonly expectConflictFields?: readonly string[];
  readonly entry?: IdentityTimelineEntry;
  readonly expectTrailLength?: number;
}

interface IdentityFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly matchable?: readonly MatchablePerson[];
  readonly links?: readonly SourceIdentifier[];
  readonly names?: readonly PersonName[];
  readonly associations?: readonly EndpointAssociation[];
  readonly trail?: readonly IdentityTimelineEntry[];
  readonly cases: readonly FixtureCase[];
}

function runCase(fixture: IdentityFixture, fixtureCase: FixtureCase): void {
  switch (fixtureCase.op) {
    case 'register': {
      if (fixtureCase.inquiry === undefined) {
        throw new Error('register case requires an inquiry');
      }
      const outcome = registerIdentityInquiry(
        fixtureCase.inquiry,
        fixture.matchable ?? [],
        fixtureCase.options ?? {},
      );
      expect(outcome.outcome).toBe(fixtureCase.expectOutcome);
      if (outcome.outcome === 'possible-match-queue') {
        if (fixtureCase.expectCandidateCount !== undefined) {
          expect(outcome.candidates).toHaveLength(fixtureCase.expectCandidateCount);
        }
        if (fixtureCase.expectMatchedAttributes !== undefined) {
          expect(outcome.candidates[0]?.matchedAttributes).toEqual(
            fixtureCase.expectMatchedAttributes,
          );
        }
        if (fixtureCase.expectStrong !== undefined) {
          expect(outcome.candidates[0]?.strong).toBe(fixtureCase.expectStrong);
        }
      }
      if (outcome.outcome === 'provisional-created') {
        expect(outcome.person.status).toBe('provisional');
        expect(outcome.person.provenance).toEqual(fixtureCase.inquiry.provenance);
      }
      for (const excluded of fixtureCase.expectSerializedExcludes ?? []) {
        expect(JSON.stringify(outcome)).not.toContain(excluded);
      }
      break;
    }
    case 'merge-basis': {
      if (fixtureCase.basis === undefined) {
        throw new Error('merge-basis case requires a basis');
      }
      if (fixtureCase.expectError !== undefined) {
        expect(() =>
          assertMergeAuthorizationBasis(fixtureCase.basis as MergeAuthorizationBasis),
        ).toThrow(fixtureCase.expectError);
      } else {
        expect(() =>
          assertMergeAuthorizationBasis(fixtureCase.basis as MergeAuthorizationBasis),
        ).not.toThrow();
      }
      break;
    }
    case 'link-source': {
      if (fixtureCase.link === undefined) {
        throw new Error('link-source case requires a link');
      }
      const outcome = linkSourceIdentifier(fixture.links ?? [], fixtureCase.link);
      expect(outcome.outcome).toBe(fixtureCase.expectOutcome);
      if (outcome.outcome === 'conflict-quarantined') {
        expect(outcome.existingLinkRetained).toBe(true);
        if (fixtureCase.expectPersonId !== undefined) {
          expect(outcome.existingLink.personId).toBe(fixtureCase.expectPersonId);
        }
      }
      if (outcome.outcome === 'duplicate-held') {
        expect(outcome.heldForReview).toBe(true);
      }
      break;
    }
    case 'resolve-source': {
      const resolved = resolvePersonBySourceId(
        fixture.links ?? [],
        (fixtureCase.link?.tenantId ?? 'northwind-synthetic') as SourceIdentifier['tenantId'],
        fixtureCase.system ?? '',
        fixtureCase.value ?? '',
      );
      expect(resolved).toBe(fixtureCase.expectPersonId ?? null);
      break;
    }
    case 'opaque-ref': {
      const invoke = (): void => {
        assertOpaqueExternalReference(fixtureCase.system ?? '', fixtureCase.value ?? '');
      };
      if (fixtureCase.expectError !== undefined) {
        expect(invoke).toThrow(fixtureCase.expectError);
      } else {
        expect(invoke).not.toThrow();
      }
      break;
    }
    case 'conversion': {
      if (fixtureCase.link === undefined || fixtureCase.attribution === undefined) {
        throw new Error('conversion case requires link and attribution');
      }
      const invoke = (): void => {
        recordBuyerConversion(
          (fixtureCase.personId ?? '') as SourceIdentifier['personId'],
          fixtureCase.link as SourceIdentifier,
          fixtureCase.attribution as BuyerConversionAttribution,
        );
      };
      if (fixtureCase.expectError !== undefined) {
        expect(invoke).toThrow(fixtureCase.expectError);
      } else {
        expect(invoke).not.toThrow();
      }
      break;
    }
    case 'name-render': {
      if (fixtureCase.context === undefined) {
        throw new Error('name-render case requires a context');
      }
      const invoke = (): ReturnType<typeof nameForContext> =>
        nameForContext(fixture.names ?? [], fixtureCase.context as NameContext);
      if (fixtureCase.expectError !== undefined) {
        expect(invoke).toThrow(fixtureCase.expectError);
        break;
      }
      const rendered = invoke();
      if (fixtureCase.expectKindUsed !== undefined) {
        expect(rendered.kindUsed).toBe(fixtureCase.expectKindUsed);
      }
      if (fixtureCase.expectGivenName !== undefined) {
        expect(rendered.givenName).toBe(fixtureCase.expectGivenName);
      }
      if (fixtureCase.expectLegalIdentifierRequired !== undefined) {
        expect(rendered.legalIdentifierRequired).toBe(fixtureCase.expectLegalIdentifierRequired);
      }
      break;
    }
    case 'name-rejection': {
      const resolution = routeExternalNameRejection(
        fixtureCase.system ?? '',
        fixtureCase.rejectionRef ?? '',
      );
      expect(resolution.outcome).toBe('reconciliation-required');
      expect(resolution.affirmedNameRetained).toBe(true);
      break;
    }
    case 'name-acks': {
      expect(
        outstandingNameAcknowledgments(
          fixtureCase.requiredSystems ?? [],
          fixtureCase.acknowledgedSystems ?? [],
        ),
      ).toEqual(fixtureCase.expectOutstanding ?? []);
      break;
    }
    case 'endpoint-persons': {
      expect(
        personsSharingEndpoint(fixture.associations ?? [], fixtureCase.endpointId ?? ''),
      ).toEqual(fixtureCase.expectPersonIds ?? []);
      break;
    }
    case 'outreach': {
      const resolution = resolveOutreachIdentity(
        fixture.associations ?? [],
        fixtureCase.endpointId ?? '',
      );
      expect(resolution.kind).toBe(fixtureCase.expectKind);
      if (resolution.kind === 'ambiguous' && fixtureCase.expectPersonIds !== undefined) {
        expect(resolution.personIds).toEqual(fixtureCase.expectPersonIds);
      }
      if (resolution.kind === 'resolved' && fixtureCase.expectPersonId !== undefined) {
        expect(resolution.personId).toBe(fixtureCase.expectPersonId);
      }
      break;
    }
    case 'dispute': {
      if (fixtureCase.dispute === undefined) {
        throw new Error('dispute case requires a dispute');
      }
      const directive = disputeEndpointOwnership(fixtureCase.dispute);
      expect(directive.suppressOutreachPersonIds).toEqual(fixtureCase.expectSuppress ?? []);
      expect(directive.resumeRequires).toBe('human-endpoint-ownership-resolution');
      break;
    }
    case 'reconcile': {
      const result = reconcileDemographics(fixtureCase.current ?? {}, fixtureCase.incoming ?? {});
      expect(result.outcome).toBe(fixtureCase.expectOutcome);
      if (result.outcome === 'review-required') {
        expect(result.sourceValuesRetained).toBe(true);
        expect(result.conflicts.map((conflict) => conflict.field)).toEqual(
          fixtureCase.expectConflictFields ?? [],
        );
      }
      break;
    }
    case 'timeline-append': {
      if (fixtureCase.entry === undefined) {
        throw new Error('timeline-append case requires an entry');
      }
      const invoke = (): readonly IdentityTimelineEntry[] =>
        appendTimelineEntry(fixture.trail ?? [], fixtureCase.entry as IdentityTimelineEntry);
      if (fixtureCase.expectError !== undefined) {
        expect(invoke).toThrow(fixtureCase.expectError);
        break;
      }
      const trail = invoke();
      expect(trail).toHaveLength(fixtureCase.expectTrailLength ?? trail.length);
      break;
    }
  }
}

for (const requirementId of [
  'REQ-ID-003',
  'REQ-ID-004',
  'REQ-ID-005',
  'REQ-ID-015',
  'REQ-ID-017',
]) {
  describe(`${requirementId} fixture pack (4-class floor)`, () => {
    const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);

    it('carries all four fixture classes with the synthetic watermark', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
    });

    for (const fixtureClass of requiredFixtureClasses) {
      describe(fixtureClass, () => {
        const fixture = pack.fixtures[fixtureClass] as unknown as IdentityFixture;
        it('declares at least one executable case', () => {
          expect(fixture.cases.length).toBeGreaterThan(0);
        });
        for (const fixtureCase of fixture.cases) {
          it(fixtureCase.name, () => {
            runCase(fixture, fixtureCase);
          });
        }
      });
    }
  });
}
