export const draftingCapabilityCeiling = 'simulated' as const;

export interface DraftingFlags {
  readonly draftingSurfacesEnabled: boolean;
  readonly capabilityState: typeof draftingCapabilityCeiling;
}

export const defaultDraftingFlags: DraftingFlags = {
  draftingSurfacesEnabled: true,
  capabilityState: draftingCapabilityCeiling,
};

export function assertSimulatedCeiling(flags: DraftingFlags): void {
  if (flags.capabilityState !== 'simulated') {
    throw new Error('WP-102 drafting surfaces stay at simulated');
  }
}
