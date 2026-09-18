/** Owned WP-033 double. SIM-KIT primitives only. Not event-spine. */
export type InjectPrimitive = 'crash' | 'replay' | 'duplicate' | 'out-of-order';

export class Wp033InjectDouble {
  public readonly applied: InjectPrimitive[] = [];

  public inject(primitive: InjectPrimitive): void {
    this.applied.push(primitive);
  }
}
