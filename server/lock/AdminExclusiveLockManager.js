/**
 * Manages admin exclusive operations with NetworkLock integration
 */
class AdminExclusiveLockManager {
  #networkLockManager = null;
  #isAdminOperationActive = false;
  #savedUserState = null;
  
  /**
   * Creates a new AdminExclusiveLockManager instance
   * @param {NetworkLockManager} networkLockManager - Network lock manager instance
   */
  constructor(networkLockManager) {
    this.#networkLockManager = networkLockManager;
  }
  
  /**
   * Executes callback under admin operation protection
   * @param {Player} player - Player instance to backup state from
   * @param {Function} asyncCallback - Async function to execute under admin operation
   * @returns {Promise<boolean>} True if operation succeeded, false if lock acquisition failed
   */
  async withAdminOperation(player, asyncCallback) {
    const acquired = await this.#networkLockManager.withLock(async () => {
      if (this.#isAdminOperationActive) {
        return false;
      }
      
      this.#savedUserState = player.getFullConfig();
      this.#isAdminOperationActive = true;
    });
    
    if (!acquired) return false;
    
    try {
      await asyncCallback();
      return true;
    } finally {
      await this.#networkLockManager.withLock(async () => {
        this.#isAdminOperationActive = false;
        this.#savedUserState = null;
      });
    }
  }
  
  /**
   * Checks if admin operation is currently active
   * @returns {boolean} True if admin operation active, false otherwise
   */
  isAdminOperationActive() {
    return this.#isAdminOperationActive;
  }
  
  /**
   * Gets the saved user state for GET requests during admin operation
   * @returns {Object|null} Saved user state or null if not in admin operation
   */
  getSavedUserState() {
    return this.#savedUserState;
  }
}

export default AdminExclusiveLockManager;