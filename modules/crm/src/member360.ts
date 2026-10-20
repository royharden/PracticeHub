import { CrmError, member360, type Member360Purpose, type MemberRecord } from './crm.js';
import type { CrmCaller, Wp015PdpPort } from './ports.js';

export interface ScopedMember360View {
  readonly personId: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly decisionRef: string;
}

/**
 * Tenant- and PDP-scoped member-360 read. The record, the caller and the
 * request must share one tenant; the PDP decides which fields the caller may
 * see for the purpose, and the result is further capped by the purpose's own
 * allowlist, so neither side can widen the other.
 */
export function member360ForCaller(request: {
  readonly tenantId: string;
  readonly caller: CrmCaller;
  readonly purpose: Member360Purpose;
  readonly record: MemberRecord;
  readonly pdp: Wp015PdpPort;
}): ScopedMember360View {
  const { tenantId, caller, purpose, record, pdp } = request;
  if (record.tenantId === undefined) {
    throw new CrmError('CRM_TENANT', `member ${record.personId} has no tenant and cannot be read`);
  }
  if (record.tenantId !== tenantId || caller.tenantId !== tenantId) {
    throw new CrmError('CRM_TENANT', 'member-360 request crosses tenants');
  }
  const decision = pdp.decideMember360({ tenantId, caller, purpose, personId: record.personId });
  if (!decision.allow) {
    throw new CrmError('CRM_PDP_DENY', `member-360 ${purpose} denied: ${decision.reason}`);
  }
  const purposeScope = member360(record, purpose);
  const granted = new Set(decision.fields);
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(purposeScope)) {
    if (name !== 'personId' && granted.has(name)) {
      fields[name] = value;
    }
  }
  return { personId: record.personId, fields, decisionRef: decision.decisionRef };
}
