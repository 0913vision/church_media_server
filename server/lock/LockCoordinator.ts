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
/** Who is holding the admin gate: a person at a panel, or a run carrying it out. */
export type GateHolder = 'person' | 'flow';

class LockCoordinator {
  private readonly audioLock: Lock;
  private readonly adminLock: Lock;
  private holder: GateHolder | null = null;

  /**
   * @param notifier - Announces each lock's state changes
   */
  constructor(notifier: Notifier) {
    // Note(yoochan.kim): Each lock announces its own transitions, so no caller has to remember to
    // report them. Both are attributes, so both travel as a state patch.
    this.audioLock = new Lock((locked) => notifier.state({ audioLock: locked }));
    this.adminLock = new Lock((locked) => notifier.state({ adminLock: locked }));
  }

  /**
   * The submission gate: whether a requester may start an operation right now.
   * Blocked only when the admin lock is held and the requester is not an admin.
   * Public so callers can tell a gated refusal from a busy device and report
   * the difference back to the client.
   */
  passesAdminGate(isAdmin: boolean): boolean {
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
   * Engages or releases the global gate, saying who is doing it. Any admin may
   * toggle it, it is broadcast to everyone, and it persists until released — a
   * setter disconnecting does NOT clear it.
   *
   * Note(yoochan.kim): the boolean was never enough. A run and a person both engage the
   * same gate, so "it is held" says nothing about whose it is — and everything
   * that read it as "mine to act on" let a person into the middle of a service,
   * or let a person's expiring hold open the panel under a run. The holder lives
   * here because it is the one thing both of them already depend on, and neither
   * of them can be made to depend on the other.
   */
  setAdminLock(locked: boolean, by: GateHolder = 'person'): void {
    if (locked) {
      this.holder = by;
      this.adminLock.tryLock();
    } else {
      this.holder = null;
      this.adminLock.unlock();
    }
  }

  /** Who engaged the gate, or null when it is open. */
  adminGateHeldBy(): GateHolder | null {
    return this.adminLock.isLocked() ? this.holder : null;
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
