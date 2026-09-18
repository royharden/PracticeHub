export type ScopeClass = 'in-scope' | 'out-of-scope';

export interface PenTestSurface {
  readonly id: string;
  readonly class: ScopeClass;
  readonly name: string;
  readonly reason: string;
}

export class PenTestScopeError extends Error {
  public constructor(public readonly code: 'EMPTY_SCOPE' | 'DUPLICATE_SURFACE') {
    super(code);
    this.name = 'PenTestScopeError';
  }
}

export class PenTestScope {
  readonly #surfaces = new Map<string, PenTestSurface>();

  public add(surface: PenTestSurface): void {
    if (this.#surfaces.has(surface.id)) throw new PenTestScopeError('DUPLICATE_SURFACE');
    this.#surfaces.set(surface.id, Object.freeze({ ...surface }));
  }

  public inScope(): readonly PenTestSurface[] {
    if (this.#surfaces.size === 0) throw new PenTestScopeError('EMPTY_SCOPE');
    return Object.freeze([...this.#surfaces.values()].filter((row) => row.class === 'in-scope'));
  }

  public outOfScope(): readonly PenTestSurface[] {
    if (this.#surfaces.size === 0) throw new PenTestScopeError('EMPTY_SCOPE');
    return Object.freeze(
      [...this.#surfaces.values()].filter((row) => row.class === 'out-of-scope'),
    );
  }
}
