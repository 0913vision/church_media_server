/**
 * Generic single-holder lock primitive.
 *
 * Announces its state via an injected callback on each acquire (true) /
 * release (false) — it knows nothing about how the announcement travels
 * (the composition wires it to a Notifier broadcast). This keeps the lock
 * module pure locking semantics, free of any transport concern.
 */
class Lock {
  #locked = false;
  #broadcastState;

  /**
   * @param {Function} broadcastState - Called with the new boolean state on
   *   every acquire/release
   */
  constructor(broadcastState) {
    this.#broadcastState = broadcastState;
  }

  /**
   * Attempts to acquire the lock. Announces `true` on success.
   * @returns {boolean} True if acquired, false if already held
   */
  tryLock() {
    if (this.#locked) {
      return false;
    }
    this.#locked = true;
    this.#broadcastState(true);
    return true;
  }

  /**
   * Releases the lock and announces `false`.
   */
  unlock() {
    if (!this.#locked) {
      return;
    }
    this.#locked = false;
    this.#broadcastState(false);
  }

  /**
   * Checks if the lock is currently held
   * @returns {boolean} True if locked, false otherwise
   */
  isLocked() {
    return this.#locked;
  }

  /**
   * Runs an async callback as a critical section: acquires the lock, runs the
   * callback, then always releases. Used for time-extended resource changes.
   * @param {Function} asyncCallback - Async function to run under the lock
   * @returns {Promise<boolean>} True if it ran, false if acquisition failed
   */
  async withLock(asyncCallback) {
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
