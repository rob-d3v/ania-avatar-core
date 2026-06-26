// Minimal typed event emitter used by the player instance. Zero deps.

export class Emitter<EventMap> {
  private listeners: { [K in keyof EventMap]?: Set<(payload: EventMap[K]) => void> } = {};

  on<E extends keyof EventMap>(event: E, cb: (payload: EventMap[E]) => void): () => void {
    (this.listeners[event] ??= new Set()).add(cb);
    return () => this.off(event, cb);
  }

  off<E extends keyof EventMap>(event: E, cb: (payload: EventMap[E]) => void): void {
    this.listeners[event]?.delete(cb);
  }

  emit<E extends keyof EventMap>(event: E, payload: EventMap[E]): void {
    const set = this.listeners[event];
    if (!set) return;
    for (const cb of set) {
      try {
        cb(payload);
      } catch {
        /* listener errors must not break emit */
      }
    }
  }

  clear(): void {
    this.listeners = {};
  }
}
