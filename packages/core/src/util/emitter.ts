export type Listener<T> = (event: T) => void;

/** Minimal typed event emitter with no dependencies. */
export class Emitter<T> {
  #listeners = new Set<Listener<T>>();

  subscribe(listener: Listener<T>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: T): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Listener errors must not break the emitter's other subscribers.
      }
    }
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  clear(): void {
    this.#listeners.clear();
  }
}
