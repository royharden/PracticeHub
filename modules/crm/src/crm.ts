export class CrmError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CrmError';
    this.code = code;
  }
}

export const pipelineStages = ['lead', 'qualified', 'member'] as const;
export type PipelineStage = (typeof pipelineStages)[number];

export interface Lead {
  readonly leadId: string;
  readonly tenantId: string;
  readonly personId: string;
  readonly stage: PipelineStage;
  readonly synthetic: true;
}

export function openLead(input: {
  readonly leadId: string;
  readonly tenantId: string;
  readonly personId: string;
}): Lead {
  return {
    leadId: input.leadId,
    tenantId: input.tenantId,
    personId: input.personId,
    stage: 'lead',
    synthetic: true,
  };
}

export function advanceLead(lead: Lead, stage: PipelineStage): Lead {
  const from = pipelineStages.indexOf(lead.stage);
  const to = pipelineStages.indexOf(stage);
  if (to !== from + 1) {
    throw new CrmError(
      'CRM_STAGE',
      `lead ${lead.leadId} cannot move from ${lead.stage} to ${stage}`,
    );
  }
  return { ...lead, stage };
}

export interface DerivedFlag {
  readonly personId: string;
  readonly name: 'high-value';
  readonly value: true;
}

export function projectDerivedFlag(personId: string): DerivedFlag {
  return { personId, name: 'high-value', value: true };
}

export function writeDerivedFlagOntoIdentity(personId: string, flag: DerivedFlag): never {
  throw new CrmError(
    'CRM_LEAK',
    `derived flag ${flag.name} cannot be written onto identity ${personId}`,
  );
}

export const member360Purposes = ['scheduling', 'billing', 'marketing'] as const;
export type Member360Purpose = (typeof member360Purposes)[number];

export interface MemberRecord {
  readonly personId: string;
  readonly preferredName: string;
  readonly planTier: string;
  readonly ageBand: string;
  readonly email: string;
  readonly householdId: string;
  readonly membershipAccountId: string;
  readonly synthetic: true;
}

export function member360(
  record: MemberRecord,
  purpose: Member360Purpose,
): { readonly personId: string } & Record<string, string> {
  switch (purpose) {
    case 'scheduling':
      return { personId: record.personId, preferredName: record.preferredName };
    case 'billing':
      return {
        personId: record.personId,
        planTier: record.planTier,
        membershipAccountId: record.membershipAccountId,
      };
    case 'marketing':
      return { personId: record.personId, ageBand: record.ageBand };
  }
}

export interface IdentitySplit {
  readonly splitId: string;
  readonly tenantId: string;
  readonly leftPersonId: string;
  readonly rightPersonId: string;
  readonly synthetic: true;
}

export function openIdentitySplit(input: {
  readonly splitId: string;
  readonly tenantId: string;
  readonly leftPersonId: string;
  readonly rightPersonId: string;
}): IdentitySplit {
  if (input.leftPersonId === input.rightPersonId) {
    throw new CrmError('CRM_SPLIT', 'an identity split needs two distinct person links');
  }
  return { ...input, synthetic: true };
}

export function mergeSilently(split: IdentitySplit): never {
  throw new CrmError(
    'CRM_SILENT_MERGE',
    `identity split ${split.splitId} cannot be merged silently`,
  );
}
