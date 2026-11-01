export type LockStateBroadcast = (locked: boolean) => void;

/** Announces itself through an injected callback, so the lock knows nothing of how the news travels. */
class Lock {
  private locked = false;

  constructor(private readonly broadcastState: LockStateBroadcast) {}

  tryLock(): boolean {
    if (this.locked) {
      return false;
    }
    this.locked = true;
    this.broadcastState(true);
    return true;
  }

  unlock(): void {
    if (!this.locked) {
      return;
    }
    this.locked = false;
    this.broadcastState(false);
  }

  isLocked(): boolean {
    return this.locked;
  }

  /** For resource changes that take time. */
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
