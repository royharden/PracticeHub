export interface SyntheticBoundaryInput {
  readonly synthetic?: boolean;
}

export function requireSyntheticInput(
  input: SyntheticBoundaryInput,
): asserts input is { synthetic: true } {
  if (input.synthetic !== true) {
    throw new Error('Local PracticeHub boundaries accept synthetic data only.');
  }
}
