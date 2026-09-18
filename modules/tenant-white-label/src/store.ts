import { WhiteLabelError, requireSynthetic } from './types.js';
import type { WhiteLabelProfile } from './types.js';

export class TenantWhiteLabelStore {
  private readonly profiles = new Map<string, WhiteLabelProfile>();

  public put(profile: WhiteLabelProfile, actorTenantId: string): WhiteLabelProfile {
    requireSynthetic(profile.synthetic);
    if (profile.tenantId !== actorTenantId) {
      throw new WhiteLabelError('cross-tenant white-label write is forbidden');
    }
    this.profiles.set(profile.tenantId, profile);
    return profile;
  }

  public get(tenantId: string, actorTenantId: string): WhiteLabelProfile {
    if (tenantId !== actorTenantId) {
      throw new WhiteLabelError('cross-tenant white-label read is forbidden');
    }
    const profile = this.profiles.get(tenantId);
    if (profile === undefined) {
      throw new WhiteLabelError('white-label profile not found');
    }
    return profile;
  }
}
