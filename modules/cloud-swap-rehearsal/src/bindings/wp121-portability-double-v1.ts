export const wp121PortabilityDoubleV1 = {
  contract: 'practicehub.wp121-portability-double',
  version: 1 as const,
  parity: 'versioned-double' as const,
};

export function portableAcross(from: string, to: string): boolean {
  return from !== to;
}
