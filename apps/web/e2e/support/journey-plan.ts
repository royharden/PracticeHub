import {
  accountableMessageContract,
  clinicalCoexistenceContract,
  paidServiceContract,
  type JourneyContract,
} from '../contracts/v1/index.js';

export interface JourneyPlan {
  readonly rowKey: string;
  readonly testId: string;
  readonly contract: JourneyContract;
}

export const journeyPlans: readonly JourneyPlan[] = [
  {
    rowKey: 'REQ-COMM-003|front-desk|cross-team-conversation-to-accepted-contextual-handoff',
    testId: 'journey:wp030:accountable-message-handoff',
    contract: accountableMessageContract,
  },
  {
    rowKey: 'REQ-SVC-001|cash-pay-customer|prospect-to-member',
    testId: 'journey:wp031:paid-service',
    contract: paidServiceContract,
  },
  {
    rowKey: 'REQ-CLIN-002|physician-app|detect-discrepancy-clinician-reconcile-acknowledge',
    testId: 'journey:wp032:clinical-coexistence',
    contract: clinicalCoexistenceContract,
  },
];

export const knownTestIds = new Set(journeyPlans.map((plan) => plan.testId));
export const knownContractIds = new Set(journeyPlans.map((plan) => plan.contract.id));

export const journeyRegistry = journeyPlans.map(({ rowKey, testId, contract }) => ({
  rowKey,
  testId,
  contractId: contract.id,
}));

export const approvedDependencyOwners: Readonly<Record<string, string>> = {
  identity: 'WP-013',
  'platform-integration': 'WP-036',
  'practice-admin': 'WP-077',
  scheduling: 'WP-040',
  'portal-intake': 'WP-043',
  comms: 'WP-044',
  voice: 'WP-046',
  telehealth: 'WP-048',
  'cash-services': 'WP-050',
  membership: 'WP-052',
  rcm: 'WP-080',
  clinical: 'WP-060',
  'labs-diagnostics': 'WP-064',
  erx: 'WP-066',
  migration: 'WP-068',
  'crm-sales': 'WP-070',
  reviews: 'WP-073',
  referrals: 'WP-074',
  'inventory-retail': 'WP-075',
  analytics: 'WP-076',
  'ai-assist': 'WP-102',
  'tasking-workflow': 'WP-022',
  'documents-fax': 'WP-049',
};

export const categoryRequirementFamilies: Readonly<Record<string, string>> = {
  identity: 'REQ-ID',
  'platform-integration': 'REQ-PLAT',
  'practice-admin': 'REQ-ADM',
  scheduling: 'REQ-SCH',
  'portal-intake': 'REQ-PORT',
  comms: 'REQ-COMM',
  voice: 'REQ-VOICE',
  telehealth: 'REQ-TELE',
  'cash-services': 'REQ-SVC',
  membership: 'REQ-MEM',
  rcm: 'REQ-RCM',
  clinical: 'REQ-CLIN',
  'labs-diagnostics': 'REQ-LAB',
  erx: 'REQ-ERX',
  migration: 'REQ-MIG',
  'crm-sales': 'REQ-CRM',
  reviews: 'REQ-REP',
  referrals: 'REQ-REF',
  'inventory-retail': 'REQ-INV',
  analytics: 'REQ-ANA',
  'ai-assist': 'REQ-AI',
  'tasking-workflow': 'REQ-TASK',
  'documents-fax': 'REQ-DOC',
};

export const requiredParityOwners: Readonly<Record<string, string>> = {
  'wp030-accountable-message-page/v1': 'WP-030',
  'wp031-paid-service-page/v1': 'WP-031',
  'wp032-clinical-coexistence-page/v1': 'WP-032',
  'portal-intake-accessibility/v1': 'WP-043',
};
