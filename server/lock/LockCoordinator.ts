import Lock from './Lock.ts';
import type Notifier from '../notify/Notifier.ts';

/** Snapshot of both lock states, for GET replies */
export interface LockState {
  audio: boolean;
  admin: boolean;
}

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
 * themselves and pass `isAdmin` booleans / opaque holder ids, and lock state
 * changes are announced through the injected notifier.
 */
class LockCoordinator {
  private readonly audioLock: Lock;
  private readonly adminLock: Lock;
  private adminLockHolderId: string | null = null; // opaque id of the current admin lock holder

  /**
   * @param notifier - Announces each lock's state changes
   */
  constructor(notifier: Notifier) {
    this.audioLock = new Lock((locked) => notifier.audioLockChanged(locked));
    this.adminLock = new Lock((locked) => notifier.adminLockChanged(locked));
  }

  /**
   * The submission gate: whether a requester may start an operation right now.
   * Blocked only when the admin lock is held and the requester is not an admin.
   */
  private passesAdminGate(isAdmin: boolean): boolean {
    return !this.adminLock.isLocked() || isAdmin;
  }

  /**
   * Runs an audio operation: passes the admin submission gate, then runs inside
   * the audio resource lock (critical section).
   * @param isAdmin - Whether the requester is an authenticated admin
   * @param asyncCallback - Async function performing the audio change
   * @returns True if it ran, false if blocked or contended
   */
  async withAudioLock(isAdmin: boolean, asyncCallback: () => Promise<void>): Promise<boolean> {
    if (!this.passesAdminGate(isAdmin)) {
      return false;
    }
    return await this.audioLock.withLock(asyncCallback);
  }

  /**
   * Runs a gated operation that takes no resource lock (used by the console):
   * passes the admin submission gate, then runs.
   * @param isAdmin - Whether the requester is an authenticated admin
   * @param asyncCallback - Async function performing the change
   * @returns True if it ran, false if blocked
   */
  async withAdminGate(isAdmin: boolean, asyncCallback: () => Promise<void>): Promise<boolean> {
    if (!this.passesAdminGate(isAdmin)) {
      return false;
    }
    await asyncCallback();
    return true;
  }

  /**
   * Acquires the admin lock for a holder (explicit toggle). The caller is
   * responsible for verifying the requester is an authenticated admin.
   * In-flight operations are unaffected; only new submissions are gated.
   * @param holderId - Opaque id of the acquiring holder (e.g. socket.id)
   * @returns True if acquired, false if already held
   */
  acquireAdminLock(holderId: string): boolean {
    const acquired = this.adminLock.tryLock();
    if (acquired) {
      this.adminLockHolderId = holderId;
    }
    return acquired;
  }

  /**
   * Releases the admin lock if this holder is the one holding it.
   * @param holderId - Opaque id of the releasing holder
   * @returns True if released
   */
  releaseAdminLock(holderId: string): boolean {
    if (this.adminLockHolderId !== holderId) {
      return false;
    }
    this.adminLock.unlock();
    this.adminLockHolderId = null;
    return true;
  }

  /**
   * Releases the admin lock if the departing holder was holding it,
   * so a dropped admin never leaves the gate stuck closed.
   * @param holderId - Opaque id of the departing holder
   */
  handleDisconnect(holderId: string): void {
    if (this.adminLockHolderId === holderId) {
      this.adminLock.unlock();
      this.adminLockHolderId = null;
    }
  }

  /**
   * Current state of both locks, for GET replies.
   */
  getLockState(): LockState {
    return {
      audio: this.audioLock.isLocked(),
      admin: this.adminLock.isLocked()
    };
  }
}

export default LockCoordinator;
