export const importWorkbenchDoubleVersion = 'wp110-import-workbench-double/v1' as const;
export const ehiDeltaDoubleVersion = 'wp068-ehi-delta-double/v1' as const;

export interface ImportWorkbenchDouble {
  readonly interfaceVersion: typeof importWorkbenchDoubleVersion;
  dryRun(panelRef: string): { readonly accepted: boolean; readonly findings: number };
}

export interface EhiDeltaDouble {
  readonly interfaceVersion: typeof ehiDeltaDoubleVersion;
  remaining(panelRef: string): number;
  drainOne(panelRef: string): number;
}
