export const leftoverReqs = [
  'REQ-MIG-001',
  'REQ-MIG-007',
  'REQ-MIG-008',
  'REQ-MIG-009',
  'REQ-MIG-019',
] as const;
export type LeftoverReq = (typeof leftoverReqs)[number];

export const rehearsalCeiling = 'simulated' as const;

export class RehearsalRefusal extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RehearsalRefusal';
  }
}

export interface RehearsalResult {
  readonly req: LeftoverReq;
  readonly outcome: 'captured' | 'continued' | 'preserved' | 'reconciled' | 'rerun' | 'blocked';
  readonly synthetic: true;
}
