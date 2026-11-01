import Lock from './Lock.ts';
import type Notifier from '../notify/Notifier.ts';

export interface LockState {
  audio: boolean;
  admin: boolean;
}

export type GateHolder = 'person' | 'flow';

/** Two orthogonal locks; it knows nothing of sockets, so callers pass `isAdmin` themselves. */
class LockCoordinator {
  /** Held only mid-transition, guarding a change that is not atomic; a contender is refused, not queued. */
  private readonly audioLock: Lock;
  /** Stops others starting anything; what is already in flight finishes on its own. */
  private readonly adminLock: Lock;
  /** Note(yoochan.kim): a run and a person share one gate, so each must know whose it is before acting on it. */
  private holder: GateHolder | null = null;

  constructor(notifier: Notifier) {
    // Note(yoochan.kim): each lock announces itself, so no caller has to remember to report it.
    this.audioLock = new Lock((locked) => notifier.state({ audioLock: locked }));
    this.adminLock = new Lock((locked) => notifier.state({ adminLock: locked }));
  }

  /** Public so a caller can tell a gated refusal from a busy device and say which. */
  passesAdminGate(isAdmin: boolean): boolean {
    return !this.adminLock.isLocked() || isAdmin;
  }

  async withAudioLock(isAdmin: boolean, asyncCallback: () => Promise<void>): Promise<boolean> {
    if (!this.passesAdminGate(isAdmin)) {
      return false;
    }
    return await this.audioLock.withLock(asyncCallback);
  }

  /** For the console, whose changes take no resource lock. */
  async withAdminGate(isAdmin: boolean, asyncCallback: () => Promise<void>): Promise<boolean> {
    if (!this.passesAdminGate(isAdmin)) {
      return false;
    }
    await asyncCallback();
    return true;
  }

  /** Any admin may toggle it, and it outlives its setter's disconnect. */
  setAdminLock(locked: boolean, by: GateHolder = 'person'): void {
    if (locked) {
      this.holder = by;
      this.adminLock.tryLock();
    } else {
      this.holder = null;
      this.adminLock.unlock();
    }
  }

  adminGateHeldBy(): GateHolder | null {
    return this.adminLock.isLocked() ? this.holder : null;
  }

  getLockState(): LockState {
    return {
      audio: this.audioLock.isLocked(),
      admin: this.adminLock.isLocked()
    };
  }
}

export default LockCoordinator;
