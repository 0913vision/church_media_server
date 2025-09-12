import NetworkLockManager from './NetworkLockManager.js';
import AdminExclusiveLockManager from './AdminExclusiveLockManager.js';

/**
 * Coordinates all locking operations for the media server
 */
class LockCoordinator {
  #networkLockManager = null;
  #adminExclusiveLockManager = null;
  
  /**
   * Creates a new LockCoordinator instance
   * @param {Object} io - Socket.IO server instance
   */
  constructor(io) {
    this.#networkLockManager = new NetworkLockManager(io);
    this.#adminExclusiveLockManager = new AdminExclusiveLockManager(this.#networkLockManager);
  }
  
  /**
   * Checks if any lock is currently active (blocks user requests)
   * @returns {boolean} True if locked, false otherwise
   */
  isLocked() {
    return this.#networkLockManager.isLocked() || this.#adminExclusiveLockManager.isAdminOperationActive();
  }
  
  /**
   * Executes callback under user lock protection
   * @param {Function} asyncCallback - Async function to execute under user lock
   * @returns {Promise<boolean>} True if operation succeeded, false if lock acquisition failed
   */
  async withUserLock(asyncCallback) {
    return await this.#networkLockManager.withLock(asyncCallback);
  }
  
  /**
   * Executes callback under admin lock protection
   * @param {Player} player - Player instance to backup state from
   * @param {Function} asyncCallback - Async function to execute under admin lock
   * @returns {Promise<boolean>} True if operation succeeded, false if lock acquisition failed
   */
  async withAdminLock(player, asyncCallback) {
    return await this.#adminExclusiveLockManager.withAdminOperation(player, asyncCallback);
  }
  
  /**
   * Gets the saved user state for display during admin operations
   * @returns {Object|null} Saved user state or null if not in admin operation
   */
  getSavedUserState() {
    return this.#adminExclusiveLockManager.getSavedUserState();
  }
  
  /**
   * Checks if admin operation is currently active
   * @returns {boolean} True if admin operation active, false otherwise
   */
  isAdminOperationActive() {
    return this.#adminExclusiveLockManager.isAdminOperationActive();
  }
}

export default LockCoordinator;