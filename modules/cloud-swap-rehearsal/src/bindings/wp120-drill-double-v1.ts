export const wp120DrillDoubleV1 = {
  contract: 'practicehub.wp120-drill-double',
  version: 1 as const,
  parity: 'versioned-double' as const,
};

export function drillGreen(profileName: string): boolean {
  return profileName === 'staging' || profileName === 'cloud-shaped';
}
