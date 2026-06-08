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
 */
class LockCoordinator {
  #audioLock;
  #adminLock;
  #adminSessionManager;
  #adminLockHolder = null; // socket.id currently holding the admin lock

  /**
   * @param {Object} io - Socket.IO server instance
   * @param {AdminSessionManager} adminSessionManager - Admin session manager
   */
  constructor(io, adminSessionManager) {
    this.#audioLock = new Lock(io, SOCKET_EVENTS.S2C_LOCK_CHANGED_EVENT);
    this.#adminLock = new Lock(io, SOCKET_EVENTS.S2C_ADMIN_LOCK_CHANGED_EVENT);
    this.#adminSessionManager = adminSessionManager;
  }

  /**
   * The submission gate: whether a socket may start an operation right now.
   * Blocked only when the admin lock is held and the requester is not an admin.
   * @param {Object} socket - Socket.IO socket instance
   * @returns {boolean}
   * @private
   */
  #passesAdminGate(socket) {
    if (!this.#adminLock.isLocked()) {
      return true;
    }
    return this.#adminSessionManager.isAdminSocket(socket);
  }

  /**
   * Runs an audio operation: passes the admin submission gate, then runs inside
   * the audio resource lock (critical section).
   * @param {Object} socket - Socket.IO socket instance
   * @param {Function} asyncCallback - Async function performing the audio change
   * @returns {Promise<boolean>} True if it ran, false if blocked or contended
   */
  async withAudioLock(socket, asyncCallback) {
    if (!this.#passesAdminGate(socket)) {
      return false;
    }
    return await this.#audioLock.withLock(asyncCallback);
  }

  /**
   * Runs a gated operation that takes no resource lock (used by the console):
   * passes the admin submission gate, then runs.
   * @param {Object} socket - Socket.IO socket instance
   * @param {Function} asyncCallback - Async function performing the change
   * @returns {Promise<boolean>} True if it ran, false if blocked
   */
  async withAdminGate(socket, asyncCallback) {
    if (!this.#passesAdminGate(socket)) {
      return false;
    }
    await asyncCallback();
    return true;
  }

  /**
   * Acquires the admin lock for an authenticated admin socket (explicit toggle).
   * In-flight operations are unaffected; only new submissions are gated.
   * @param {Object} socket - Socket.IO socket instance
   * @returns {boolean} True if acquired, false if not an admin or already held
   */
  acquireAdminLock(socket) {
    if (!this.#adminSessionManager.isAdminSocket(socket)) {
      return false;
    }
    const acquired = this.#adminLock.tryLock();
    if (acquired) {
      this.#adminLockHolder = socket.id;
    }
    return acquired;
  }

  /**
   * Releases the admin lock if this socket is the holder.
   * @param {Object} socket - Socket.IO socket instance
   * @returns {boolean} True if released
   */
  releaseAdminLock(socket) {
    if (this.#adminLockHolder !== socket.id) {
      return false;
    }
    this.#adminLock.unlock();
    this.#adminLockHolder = null;
    return true;
  }

  /**
   * Releases the admin lock if the disconnecting socket was holding it,
   * so a dropped admin never leaves the gate stuck closed.
   * @param {Object} socket - Socket.IO socket instance
   */
  handleDisconnect(socket) {
    if (this.#adminLockHolder === socket.id) {
      this.#adminLock.unlock();
      this.#adminLockHolder = null;
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
