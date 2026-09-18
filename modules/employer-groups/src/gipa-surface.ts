import { EmployerGroupError } from './types.js';

export type EmployerSurfaceQuery = {
  readonly employerRef: string;
  readonly employeeId: string;
  readonly field: 'clinical' | 'invoice-headcount' | 'eligibility';
};

/** Fail-closed employer surface. Clinical fields never return. IC-2 fuzzing is forwarded. */
export class GipaSurface {
  public constructor(private readonly partitionSimulated: boolean) {}

  public query(input: EmployerSurfaceQuery):
    | { readonly allowed: false; readonly reason: string }
    | {
        readonly allowed: true;
        readonly field: 'invoice-headcount' | 'eligibility';
      } {
    if (input.field === 'clinical') {
      throw new EmployerGroupError('clinical fields are not an employer surface', 'gipa-clinical');
    }
    if (!this.partitionSimulated) {
      throw new EmployerGroupError(
        'employer surface denied below privacy.gipa-partition simulated',
        'gipa-partition',
      );
    }
    return { allowed: true, field: input.field };
  }
}
