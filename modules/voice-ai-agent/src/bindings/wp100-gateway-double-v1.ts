export const wp100GatewayDoubleV1 = {
  contract: 'practicehub.wp100-gateway-double',
  version: 1 as const,
  parity: 'versioned-double' as const,
  mode: 'dev' as const,
  syntheticOnly: true,
};

export function assertSyntheticGateway(synthetic: true): void {
  if (synthetic !== true) {
    throw new Error('NON_SYNTHETIC_GATEWAY');
  }
}
