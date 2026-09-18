export type ComponentKind = 'awv' | 'ippe' | 'cash-service' | 'lab' | 'other';

export interface ComponentMapLine {
  readonly componentRef: string;
  readonly kind: ComponentKind;
  readonly quantity: number;
  readonly billed: boolean;
}

export interface ComponentMap {
  readonly tenantId: string;
  readonly mapVersionRef: string;
  readonly skuRef: string;
  readonly lines: readonly ComponentMapLine[];
}

export class ComponentMapError extends Error {
  public constructor(
    public readonly code: 'MAP_NOT_FOUND' | 'COMPOSITION_INCOMPLETE' | 'MAP_INVALID',
  ) {
    super(code);
    this.name = 'ComponentMapError';
  }
}

const mapKey = (tenantId: string, skuRef: string, mapVersionRef: string): string =>
  JSON.stringify([tenantId, skuRef, mapVersionRef]);

const freezeMap = (map: ComponentMap): ComponentMap =>
  Object.freeze({
    ...map,
    lines: Object.freeze(map.lines.map((line) => Object.freeze({ ...line }))),
  });

export class ComponentMaps {
  readonly #maps = new Map<string, ComponentMap>();

  public add(map: ComponentMap): void {
    if (map.lines.length === 0) throw new ComponentMapError('MAP_INVALID');
    const refs = map.lines.map((line) => line.componentRef);
    if (refs.some((ref) => ref === '') || new Set(refs).size !== refs.length) {
      throw new ComponentMapError('MAP_INVALID');
    }
    if (map.lines.some((line) => !Number.isSafeInteger(line.quantity) || line.quantity <= 0)) {
      throw new ComponentMapError('MAP_INVALID');
    }
    this.#maps.set(mapKey(map.tenantId, map.skuRef, map.mapVersionRef), freezeMap(map));
  }

  public proveComposition(input: {
    readonly tenantId: string;
    readonly skuRef: string;
    readonly mapVersionRef: string;
    readonly billedComponentRefs: readonly string[];
  }): ComponentMap {
    const map = this.#maps.get(mapKey(input.tenantId, input.skuRef, input.mapVersionRef));
    if (map === undefined) throw new ComponentMapError('MAP_NOT_FOUND');
    const billed = new Set(
      map.lines.filter((line) => line.billed).map((line) => line.componentRef),
    );
    if (input.billedComponentRefs.length === 0)
      throw new ComponentMapError('COMPOSITION_INCOMPLETE');
    if (input.billedComponentRefs.some((ref) => !billed.has(ref))) {
      throw new ComponentMapError('COMPOSITION_INCOMPLETE');
    }
    if (billed.size !== new Set(input.billedComponentRefs).size) {
      throw new ComponentMapError('COMPOSITION_INCOMPLETE');
    }
    return map;
  }
}
