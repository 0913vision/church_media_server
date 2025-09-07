import { SOCKET_EVENTS } from '../constants/socketConfig.js';

/**
 * Manages network-level locking for player operations
 * Broadcasts lock state changes to all connected clients
 */
class NetworkLockManager {
  #locked = false;
  #io = null;
  
  /**
   * Creates a new NetworkLockManager instance
   * @param {Object} io - Socket.IO server instance
   */
  constructor(io) {
    this.#io = io;
  }
  
  /**
   * Attempts to acquire the lock
   * @returns {boolean} True if lock acquired successfully, false if already locked
   */
  tryLock() {
    if (this.#locked) {
      return false; // Lock already held
    }
    
    this.#locked = true;
    this.#io.emit(SOCKET_EVENTS.S2C_LOCK_CHANGED_EVENT, true);
    return true; // Lock acquired
  }
  
  /**
   * Releases the lock and broadcasts to all clients
   * @private
   */
  #unlock() {
    this.#locked = false;
    this.#io.emit(SOCKET_EVENTS.S2C_LOCK_CHANGED_EVENT, false);
  }
  
  /**
   * Checks if the lock is currently held
   * @returns {boolean} True if locked, false otherwise
   */
  isLocked() {
    return this.#locked;
  }
  
  /**
   * Executes callback with lock protection
   * Automatically acquires lock, executes callback, then releases lock
   * @param {Function} asyncCallback - Async function to execute under lock
   * @returns {Promise<boolean>} True if operation succeeded, false if lock acquisition failed
   */
  async withLock(asyncCallback) {
    if (!this.tryLock()) {
      return false; // Lock acquisition failed
    }
    
    try {
      await asyncCallback();
      return true; // Operation succeeded
    } finally {
      this.#unlock(); // Always release lock
    }
  }
}

export default NetworkLockManager;