/**
 * Named placeholder ports for modules CRM consumes but does not yet depend on
 * (package.json dependencies are integrator-owned). Each port is the minimal
 * surface CRM needs; the binding adapters replace the doubles below.
 */
import type { Member360Purpose } from './crm.js';

/** A caller of a CRM read: the acting principal, in one tenant. */
export interface CrmCaller {
  readonly actorId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
}

/** WP-015 PDP placeholder: decides whether a caller may read a member for a purpose. */
export interface Wp015PdpPort {
  decideMember360(request: {
    readonly tenantId: string;
    readonly caller: CrmCaller;
    readonly purpose: Member360Purpose;
    readonly personId: string;
  }):
    | { readonly allow: true; readonly fields: readonly string[]; readonly decisionRef: string }
    | { readonly allow: false; readonly reason: string; readonly decisionRef: string };
}

/** WP-013 identity snapshot as CRM may see it. CRM holds references only. */
export interface IdentitySnapshot {
  readonly tenantId: string;
  readonly personId: string;
  readonly status: string;
  readonly attributes: Readonly<Record<string, string>>;
}

/**
 * WP-013 identity placeholder, READ side only. CRM is given this type, so no
 * CRM code path can reach an identity write: derived flags travel one way.
 */
export interface IdentityReadPort {
  read(tenantId: string, personId: string): IdentitySnapshot | undefined;
}

/** WP-016 merge-case placeholder: the governed case a split resolves through. */
export interface Wp016MergeCasePort {
  get(
    tenantId: string,
    caseId: string,
  ):
    | {
        readonly caseId: string;
        readonly tenantId: string;
        readonly status:
          'open' | 'resolved-linked' | 'resolved-distinct' | 'resolved-merged' | 'dismissed';
        readonly personIds: readonly string[];
      }
    | undefined;
}

/** Role-based synthetic PDP double: role -> purposes -> allowed fields. */
export class StaticMember360Pdp implements Wp015PdpPort {
  public readonly decisions: string[] = [];

  public constructor(
    private readonly grants: Readonly<
      Record<string, Partial<Record<Member360Purpose, readonly string[]>>>
    >,
  ) {}

  public decideMember360(request: Parameters<Wp015PdpPort['decideMember360']>[0]) {
    const decisionRef = `pdp:${request.tenantId}:${request.caller.actorId}:${request.purpose}:${request.personId}`;
    this.decisions.push(decisionRef);
    if (request.caller.tenantId !== request.tenantId) {
      return { allow: false as const, reason: 'caller-tenant-mismatch', decisionRef };
    }
    const fields = new Set<string>();
    for (const role of request.caller.roles) {
      for (const field of this.grants[role]?.[request.purpose] ?? []) {
        fields.add(field);
      }
    }
    if (fields.size === 0) {
      return { allow: false as const, reason: 'purpose-not-granted', decisionRef };
    }
    return { allow: true as const, fields: [...fields].sort(), decisionRef };
  }
}

/**
 * Identity double that ALSO has a write method, so a test can prove CRM never
 * calls it. It is handed to CRM only as an `IdentityReadPort`.
 */
export class RecordingIdentityPort implements IdentityReadPort {
  public writeCalls = 0;
  readonly #people = new Map<string, IdentitySnapshot>();

  public seed(snapshot: IdentitySnapshot): void {
    this.#people.set(`${snapshot.tenantId}|${snapshot.personId}`, structuredClone(snapshot));
  }

  public read(tenantId: string, personId: string): IdentitySnapshot | undefined {
    const found = this.#people.get(`${tenantId}|${personId}`);
    return found === undefined ? undefined : structuredClone(found);
  }

  /** The identity-owned write path. CRM must never reach it. */
  public updateAttributes(
    tenantId: string,
    personId: string,
    attributes: Record<string, string>,
  ): void {
    this.writeCalls += 1;
    const found = this.#people.get(`${tenantId}|${personId}`);
    if (found !== undefined) {
      this.#people.set(`${tenantId}|${personId}`, {
        ...found,
        attributes: { ...found.attributes, ...attributes },
      });
    }
  }
}
