/** Announces a lock's new state to interested parties */
export type LockStateBroadcast = (locked: boolean) => void;

/**
 * Generic single-holder lock primitive.
 *
 * Announces its state via an injected callback on each acquire (true) /
 * release (false) — it knows nothing about how the announcement travels
 * (the composition wires it to a Notifier broadcast). This keeps the lock
 * module pure locking semantics, free of any transport concern.
 */
class Lock {
  private locked = false;

  /**
   * @param broadcastState - Called with the new boolean state on every
   *   acquire/release
   */
  constructor(private readonly broadcastState: LockStateBroadcast) {}

  /**
   * Attempts to acquire the lock. Announces `true` on success.
   * @returns True if acquired, false if already held
   */
  tryLock(): boolean {
    if (this.locked) {
      return false;
    }
    this.locked = true;
    this.broadcastState(true);
    return true;
  }

  /**
   * Releases the lock and announces `false`.
   */
  unlock(): void {
    if (!this.locked) {
      return;
    }
    this.locked = false;
    this.broadcastState(false);
  }

  /**
   * Checks if the lock is currently held
   */
  isLocked(): boolean {
    return this.locked;
  }

  /**
   * Runs an async callback as a critical section: acquires the lock, runs the
   * callback, then always releases. Used for time-extended resource changes.
   * @returns True if it ran, false if acquisition failed
   */
  async withLock(asyncCallback: () => Promise<void>): Promise<boolean> {
    if (!this.tryLock()) {
      return false;
    }
    try {
      await asyncCallback();
      return true;
    } finally {
      this.unlock();
    }
  }
}

export default Lock;
