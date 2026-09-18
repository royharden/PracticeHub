export const drillRegistryDoubleVersion = 'wp120-drill-registry-double/v1' as const;

export interface DrillRegistryDouble {
  readonly interfaceVersion: typeof drillRegistryDoubleVersion;
  record(drillId: string, outcome: 'green' | 'blocked'): void;
}
