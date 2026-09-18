export type TenantId = string & { readonly __brand: 'TenantId' };
export type Tin = string & { readonly __brand: 'Tin' };

export type EmploymentStatus = 'active' | 'terminated' | 'cobra';
export type QleKind = 'hire' | 'termination' | 'birth' | 'divorce' | 'cobra-elect';

export interface EmployerGroup {
  readonly contractId: 'employer-group/v1';
  readonly tenantId: TenantId;
  readonly employerRef: string;
  readonly tins: readonly Tin[];
  readonly committedHeadcount: number;
  readonly rates: Readonly<Record<string, number>>;
  readonly synthetic: true;
}

export interface RosterRow {
  readonly employeeId: string;
  readonly name: string;
  readonly dob: string;
  readonly tin: Tin;
  readonly tier: string;
  readonly status: EmploymentStatus;
  readonly effectiveDate: string;
  readonly terminationDate: string | null;
  readonly medicareEligible: boolean;
  readonly source: string;
  readonly synthetic: true;
}

export interface RowError {
  readonly employeeId: string;
  readonly reason: string;
  readonly synthetic: true;
}

export interface RosterDiff {
  readonly additions: readonly RosterRow[];
  readonly terminations: readonly RosterRow[];
  readonly changes: readonly RosterRow[];
  readonly errors: readonly RowError[];
  readonly invitedCount: number;
  readonly heldCount: number;
  readonly alreadyEnrolledCount: number;
  readonly headcountVariance: boolean;
  readonly confirmed: boolean;
  readonly synthetic: true;
}

export interface InvoiceLine {
  readonly tin: Tin;
  readonly tier: string;
  readonly headcount: number;
  readonly rate: number;
  readonly amount: number;
  readonly synthetic: true;
}

export class EmployerGroupError extends Error {
  public override readonly name = 'EmployerGroupError';
  public constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}
