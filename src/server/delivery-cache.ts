export class DeliveryCache {
  readonly #max: number;
  readonly #order: string[] = [];
  readonly #seen = new Set<string>();

  constructor(maxEntries: number) {
    this.#max = maxEntries;
  }

  has(deliveryId: string): boolean {
    return this.#seen.has(deliveryId);
  }

  remember(deliveryId: string): void {
    if (this.#seen.has(deliveryId)) {
      return;
    }
    this.#seen.add(deliveryId);
    this.#order.push(deliveryId);
    while (this.#order.length > this.#max) {
      const oldest = this.#order.shift();
      if (oldest !== undefined) {
        this.#seen.delete(oldest);
      }
    }
  }
}
