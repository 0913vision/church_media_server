/**
 * Generic single-holder lock primitive.
 *
 * Owns its own broadcast event name and the io instance, and announces its
 * state to every connected client on each acquire (true) / release (false).
 * This is the same propagation mechanism the server has always used for the
 * lock — generalized so each kind of lock (audio, admin) broadcasts on its
 * own event.
 */
class Lock {
  #locked = false;
  #io;
  #eventName;

  /**
   * @param {Object} io - Socket.IO server instance
   * @param {string} eventName - S2C event name to broadcast this lock's state on
   */
  constructor(io, eventName) {
    this.#io = io;
    this.#eventName = eventName;
  }

  /**
   * Attempts to acquire the lock. Broadcasts `true` to all clients on success.
   * @returns {boolean} True if acquired, false if already held
   */
  tryLock() {
    if (this.#locked) {
      return false;
    }
    this.#locked = true;
    this.#io.emit(this.#eventName, true);
    return true;
  }

  /**
   * Releases the lock and broadcasts `false` to all clients.
   */
  unlock() {
    if (!this.#locked) {
      return;
    }
    this.#locked = false;
    this.#io.emit(this.#eventName, false);
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
