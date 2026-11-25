/**
 * The channel between a page and the page it opened with `wx.navigateTo`: each
 * end's `emit` reaches the listeners of the other end. An event emitted before
 * the other end listens for it waits, so the opener can emit in `success`
 * before the new page's `onLoad` has called `on`.
 */
type Listener = (...args: unknown[]) => void;

export interface EventChannel {
  on(name: string, listener: Listener): void;
  once(name: string, listener: Listener): void;
  off(name: string, listener?: Listener): void;
  emit(name: string, ...args: unknown[]): void;
}

class End implements EventChannel {
  peer?: End;
  private readonly listeners = new Map<string, { fn: Listener; once: boolean }[]>();
  private readonly waiting = new Map<string, unknown[][]>();

  on(name: string, listener: Listener): void {
    this.listen(name, listener, false);
  }
  once(name: string, listener: Listener): void {
    this.listen(name, listener, true);
  }
  off(name: string, listener?: Listener): void {
    if (!listener) this.listeners.delete(name);
    else
      this.listeners.set(
        name,
        (this.listeners.get(name) ?? []).filter((l) => l.fn !== listener),
      );
  }
  emit(name: string, ...args: unknown[]): void {
    this.peer?.receive(name, args);
  }

  private listen(name: string, fn: Listener, once: boolean) {
    if (typeof fn !== "function") return;
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), { fn, once }]);
    const waiting = this.waiting.get(name);
    this.waiting.delete(name);
    for (const args of waiting ?? []) this.receive(name, args);
  }

  private receive(name: string, args: unknown[]) {
    const listeners = this.listeners.get(name) ?? [];
    if (listeners.length === 0) {
      this.waiting.set(name, [...(this.waiting.get(name) ?? []), args]);
      return;
    }
    this.listeners.set(
      name,
      listeners.filter((listener) => !listener.once),
    );
    for (const { fn } of listeners) {
      try {
        fn(...args);
      } catch (error) {
        console.error(`[omr] error in EventChannel listener for "${name}":`, error);
      }
    }
  }
}

/** Creates the two ends of a channel; `events` are the opener's listeners from `wx.navigateTo`. */
export function createEventChannel(events: unknown): {
  opener: EventChannel;
  opened: EventChannel;
} {
  const opener = new End();
  const opened = new End();
  opener.peer = opened;
  opened.peer = opener;
  if (events && typeof events === "object") {
    for (const [name, fn] of Object.entries(events as Record<string, unknown>)) {
      if (typeof fn === "function") opener.on(name, fn as Listener);
    }
  }
  return { opener, opened };
}
