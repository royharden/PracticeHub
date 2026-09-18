export const workbenchDoubleVersion = 'wp110-import-workbench-double/v1' as const;
export const cutoverDoubleVersion = 'wp114-cutover-double/v1' as const;

export interface WorkbenchDouble {
  readonly interfaceVersion: typeof workbenchDoubleVersion;
  dryRunAccepted(): boolean;
}

export interface CutoverDouble {
  readonly interfaceVersion: typeof cutoverDoubleVersion;
  frozen(): boolean;
}
