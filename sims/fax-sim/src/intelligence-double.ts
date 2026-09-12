/** Deterministic synthetic IDP/urgency double for WP-049 contract tests. */

import type {
  FaxInspection,
  FaxIntelligencePort,
  FaxPatientMatchPort,
  FaxPatientMatchResult,
  FaxWorkItemPort,
  ObservableAttributeName,
} from '@practicehub/documents';

export type FaxIntelligenceScenario =
  | 'single-match'
  | 'multi-patient'
  | 'ambiguous'
  | 'sub-threshold'
  | 'unreadable-urgent'
  | 'urgent'
  | 'uncertain-urgent';

const facts = (suffix: string): Readonly<Record<string, string>> => ({
  'given-name': `synthetic-given-${suffix}`,
  'family-name': `synthetic-family-${suffix}`,
  'birth-date': '1980-01-01',
});

const attributes: readonly ObservableAttributeName[] = ['patient-name', 'date-of-birth'];

export function createFaxIntelligenceDouble(
  scenario: FaxIntelligenceScenario,
): FaxIntelligencePort {
  return {
    async inspect(input): Promise<FaxInspection> {
      const split = scenario === 'multi-patient' && input.pageCount >= 2;
      const midpoint = Math.floor(input.pageCount / 2);
      const pages = Array.from({ length: input.pageCount }, (_, index) => index + 1);
      const groups = split
        ? [
            {
              groupId: 'fax-group-a',
              pages: pages.slice(0, midpoint),
              documentType: 'referral' as const,
              identityEvidence: {
                facts: facts('a'),
                observedAttributeNames: attributes,
                evidenceRef: 'synthetic-idp:evidence-a',
              },
              confidence: 0.98,
            },
            {
              groupId: 'fax-group-b',
              pages: pages.slice(midpoint),
              documentType: 'outside-records' as const,
              identityEvidence: {
                facts: facts('b'),
                observedAttributeNames: attributes,
                evidenceRef: 'synthetic-idp:evidence-b',
              },
              confidence: 0.97,
            },
          ]
        : [
            {
              groupId: 'fax-group-all',
              pages,
              documentType: 'referral' as const,
              identityEvidence: {
                facts: facts('all'),
                observedAttributeNames: attributes,
                evidenceRef: 'synthetic-idp:evidence-all',
              },
              confidence: scenario === 'sub-threshold' ? 0.49 : 1,
            },
          ];
      const signal =
        scenario === 'urgent'
          ? ('positive' as const)
          : scenario === 'uncertain-urgent' || scenario === 'unreadable-urgent'
            ? ('uncertain' as const)
            : ('negative' as const);
      return {
        tenantId: input.tenantId,
        faxId: input.faxId,
        documentId: input.documentId,
        providerRef: 'synthetic-idp:fax-double',
        providerVersion: 'synthetic-idp-v1',
        readable: scenario !== 'unreadable-urgent',
        groups,
        urgency: { signal, evidenceRef: `synthetic-urgency:${scenario}` },
        realParityCase: `fax-parity:${scenario}`,
        synthetic: true,
      };
    },
  };
}

export function createFaxPatientMatchDouble(
  scenario: FaxIntelligenceScenario,
): FaxPatientMatchPort {
  return {
    async resolve(input): Promise<FaxPatientMatchResult> {
      if (scenario === 'ambiguous') {
        return {
          kind: 'ambiguous',
          tenantId: input.tenantId,
          candidates: [
            { personRef: 'synthetic-person:candidate-a', matchedAttributeNames: attributes },
            { personRef: 'synthetic-person:candidate-b', matchedAttributeNames: attributes },
          ],
        };
      }
      if (scenario === 'unreadable-urgent') {
        return { kind: 'none', tenantId: input.tenantId };
      }
      const suffix = input.groupId.endsWith('-b') ? 'b' : 'a';
      return {
        kind: 'single',
        tenantId: input.tenantId,
        personRef: `synthetic-person:${suffix}`,
        matchedAttributeNames: attributes,
      };
    },
  };
}

export function createFaxWorkItemDouble(trace?: string[]): {
  readonly openUrgent: FaxWorkItemPortMethod;
} {
  const openedByKey = new Map<string, string>();
  return {
    async openUrgent(input) {
      const prior = openedByKey.get(input.idempotencyKey);
      if (prior !== undefined) {
        return { workItemRef: prior, outcome: 'deduplicated', resendsExternalEffect: false };
      }
      trace?.push(`urgent:${input.tenantId}:${input.documentId}`);
      const workItemRef = `synthetic-workitem:${input.documentId}`;
      openedByKey.set(input.idempotencyKey, workItemRef);
      return { workItemRef, outcome: 'opened', resendsExternalEffect: false };
    },
  };
}

type FaxWorkItemPortMethod = FaxWorkItemPort['openUrgent'];
