export interface ClinicBootstrapDouble {
  readonly doubleId: 'wp118-bootstrap-double/v1';
  hoursFor(tenantId: string): { readonly timezone: string };
}

export interface BrandKitDouble {
  readonly doubleId: 'wp077-brand-double/v1';
  wordmarkFor(tenantId: string): string;
}
