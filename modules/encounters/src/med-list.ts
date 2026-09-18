export class MedListError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MedListError';
  }
}

export interface MedListItem {
  readonly itemId: string;
  readonly display: string;
  readonly ownerRef: string;
}

/**
 * Single-owner medication list per tenant+person. A second owner is refused.
 */
export class MedicationList {
  private ownerRef: string | null = null;
  private readonly items = new Map<string, MedListItem>();

  public constructor(
    public readonly tenantId: string,
    public readonly personId: string,
  ) {}

  public claimOwner(ownerRef: string): string {
    if (this.ownerRef !== null && this.ownerRef !== ownerRef) {
      throw new MedListError('med-list already has a single owner');
    }
    this.ownerRef = ownerRef;
    return ownerRef;
  }

  public add(itemId: string, display: string, actorRef: string): MedListItem {
    this.requireOwner(actorRef);
    const item: MedListItem = { itemId, display, ownerRef: actorRef };
    this.items.set(itemId, item);
    return item;
  }

  public remove(itemId: string, actorRef: string): void {
    this.requireOwner(actorRef);
    this.items.delete(itemId);
  }

  public list(): readonly MedListItem[] {
    return [...this.items.values()];
  }

  public owner(): string | null {
    return this.ownerRef;
  }

  private requireOwner(actorRef: string): void {
    if (this.ownerRef === null) {
      throw new MedListError('med-list has no owner');
    }
    if (this.ownerRef !== actorRef) {
      throw new MedListError('med-list writes are reserved to the single owner');
    }
  }
}
