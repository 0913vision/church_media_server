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
 * themselves and pass `isAdmin` booleans, and lock state changes are announced
 * through the injected notifier.
 */
class LockCoordinator {
  private readonly audioLock: Lock;
  private readonly adminLock: Lock;

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
   * Sets the global admin lock on or off. The admin lock is server-global
   * state: any authenticated admin may toggle it (the caller verifies admin
   * identity), the new value is broadcast to everyone, and it persists until an
   * admin turns it off — a setter disconnecting does NOT clear it. Idempotent:
   * the notifier only broadcasts on an actual on/off transition.
   * @param locked - true to engage the gate, false to release it
   */
  setAdminLock(locked: boolean): void {
    if (locked) {
      this.adminLock.tryLock();
    } else {
      this.adminLock.unlock();
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
