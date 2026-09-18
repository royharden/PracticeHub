import type { MembershipVintage } from '../types.js';

export class MembershipDouble {
  readonly #byMember = new Map<string, MembershipVintage>();

  put(vintage: MembershipVintage): void {
    this.#byMember.set(vintage.memberRef, vintage);
  }

  get(memberRef: string): MembershipVintage | undefined {
    return this.#byMember.get(memberRef);
  }
}
