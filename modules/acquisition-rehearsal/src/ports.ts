export interface ImportWorkbenchPort {
  readonly doubleId: 'wp110-import-workbench-double/v1';
  importPanel(input: {
    readonly tenantId: string;
    readonly panelId: string;
    readonly subjectRefs: readonly string[];
  }): { readonly imported: number };
}

export interface CutoverHarnessPort {
  readonly doubleId: 'wp114-cutover-double/v1';
  cutOver(input: {
    readonly tenantId: string;
    readonly panelId: string;
    readonly imported: number;
  }): { readonly cutOver: number; readonly failed: boolean };
  restoreAndRekey(input: { readonly tenantId: string; readonly panelId: string }): {
    readonly restored: true;
    readonly rekeyed: true;
  };
}
