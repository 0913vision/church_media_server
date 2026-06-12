import Lock from './Lock.js';
import { SOCKET_EVENTS } from '../constants/socketConfig.js';

/**
 * Coordinates the server's two distinct, independent locks.
 *
 *  - audioLock (resource / critical section): held only while the audio device
 *    is mid-transition (play / pause / song change). It protects a non-atomic,
 *    time-extended change; contending audio requests are rejected. Broadcast on
 *    its own event (S2C_LOCK_CHANGED_EVENT).
 *
 *  - adminLock (global gate): when an authenticated admin holds it, no other
 *    user may SUBMIT (start) a new operation. Operations already in flight are
 *    untouched and complete independently. Broadcast on a completely separate
 *    event (S2C_ADMIN_LOCK_CHANGED_EVENT).
 *
 * The two are orthogonal: the admin lock gates *who may start an operation*,
 * the audio lock gates *concurrent mutation of the audio resource*.
 *
 * This layer knows nothing about sockets or sessions: callers resolve identity
 * themselves and pass `isAdmin` booleans / opaque holder ids.
 */
class LockCoordinator {
  #audioLock;
  #adminLock;
  #adminLockHolderId = null; // opaque id of the current admin lock holder

  /**
   * @param {Object} io - Socket.IO server instance (used only by the locks to
   *   broadcast their own state)
   */
  constructor(io) {
    this.#audioLock = new Lock(io, SOCKET_EVENTS.S2C_LOCK_CHANGED_EVENT);
    this.#adminLock = new Lock(io, SOCKET_EVENTS.S2C_ADMIN_LOCK_CHANGED_EVENT);
  }

  /**
   * The submission gate: whether a requester may start an operation right now.
   * Blocked only when the admin lock is held and the requester is not an admin.
   * @param {boolean} isAdmin - Whether the requester is an authenticated admin
   * @returns {boolean}
   * @private
   */
  #passesAdminGate(isAdmin) {
    return !this.#adminLock.isLocked() || isAdmin;
  }

  /**
   * Runs an audio operation: passes the admin submission gate, then runs inside
   * the audio resource lock (critical section).
   * @param {boolean} isAdmin - Whether the requester is an authenticated admin
   * @param {Function} asyncCallback - Async function performing the audio change
   * @returns {Promise<boolean>} True if it ran, false if blocked or contended
   */
  async withAudioLock(isAdmin, asyncCallback) {
    if (!this.#passesAdminGate(isAdmin)) {
      return false;
    }
    return await this.#audioLock.withLock(asyncCallback);
  }

  /**
   * Runs a gated operation that takes no resource lock (used by the console):
   * passes the admin submission gate, then runs.
   * @param {boolean} isAdmin - Whether the requester is an authenticated admin
   * @param {Function} asyncCallback - Async function performing the change
   * @returns {Promise<boolean>} True if it ran, false if blocked
   */
  async withAdminGate(isAdmin, asyncCallback) {
    if (!this.#passesAdminGate(isAdmin)) {
      return false;
    }
    await asyncCallback();
    return true;
  }

  /**
   * Acquires the admin lock for a holder (explicit toggle). The caller is
   * responsible for verifying the requester is an authenticated admin.
   * In-flight operations are unaffected; only new submissions are gated.
   * @param {string} holderId - Opaque id of the acquiring holder (e.g. socket.id)
   * @returns {boolean} True if acquired, false if already held
   */
  acquireAdminLock(holderId) {
    const acquired = this.#adminLock.tryLock();
    if (acquired) {
      this.#adminLockHolderId = holderId;
    }
    return acquired;
  }

  /**
   * Releases the admin lock if this holder is the one holding it.
   * @param {string} holderId - Opaque id of the releasing holder
   * @returns {boolean} True if released
   */
  releaseAdminLock(holderId) {
    if (this.#adminLockHolderId !== holderId) {
      return false;
    }
    this.#adminLock.unlock();
    this.#adminLockHolderId = null;
    return true;
  }

  /**
   * Releases the admin lock if the departing holder was holding it,
   * so a dropped admin never leaves the gate stuck closed.
   * @param {string} holderId - Opaque id of the departing holder
   */
  handleDisconnect(holderId) {
    if (this.#adminLockHolderId === holderId) {
      this.#adminLock.unlock();
      this.#adminLockHolderId = null;
    }
  }

  /**
   * Current state of both locks, for GET replies.
   * @returns {{audio: boolean, admin: boolean}}
   */
  getLockState() {
    return {
      audio: this.#audioLock.isLocked(),
      admin: this.#adminLock.isLocked()
    };
  }
}

export default LockCoordinator;
