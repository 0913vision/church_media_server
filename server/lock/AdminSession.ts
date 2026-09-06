import type Player from '../player/Player.ts';
import type LockCoordinator from './LockCoordinator.ts';
import type Notifier from '../notify/Notifier.ts';
import type Clock from '../clock/Clock.ts';
import type { Deadline, StatePatch } from '../protocol.ts';
import { formatInstant } from '../utils/instant.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

const POLL_MS = 1000;
/** The longest a gate a person engaged may still have to run. */
export const HOLD_LIMIT_MS = 60 * 60 * 1000;
/** What one press of extend buys. */
export const EXTEND_MS = 30 * 60 * 1000;

const NONE: Deadline = { kind: 'none' };

/**
 * Everything about a gate a person is holding that runs on a clock: when the
 * music stops, and when the hold itself lapses.
 *
 * Note(yoochan.kim): the two belong together because a hold has exactly one way of
 * ending badly — nobody comes back. Looping audio never runs out, so the gate
 * over it would be held until morning; and a person who locks the panel and
 * goes home has locked out everyone else in the building. One clock answers
 * both: the music has an end, and so does the hold.
 *
 * A flow's gate is none of this. A run names its own window and unwinds itself.
 */
class AdminSession {
  private unlockWhenDone = false;
  private musicEnd: Date | undefined;
  private lapsesAt: Date | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly player: Player,
    private readonly lockCoordinator: LockCoordinator,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
  ) {}

  isArmed(): boolean {
    return this.unlockWhenDone;
  }

  /** Whether the music stopping should take the gate with it. */
  setUnlockWhenDone(armed: boolean): void {
    this.unlockWhenDone = armed;
    this.sync();
  }

  musicEndsAt(): Deadline {
    return this.musicEnd ? { kind: 'at', at: formatInstant(this.musicEnd) } : NONE;
  }

  setMusicEndsAt(at: Date | undefined): void {
    this.musicEnd = at;
    this.sync();
  }

  adminHold(): Deadline {
    return this.lapsesAt ? { kind: 'at', at: formatInstant(this.lapsesAt) } : NONE;
  }

  /** Starts the hour running. Called when a person engages the gate, never for a flow. */
  engage(): void {
    this.lapsesAt = new Date(this.clock.now().getTime() + HOLD_LIMIT_MS);
    this.sync();
  }

  /**
   * Pushes the lapse back, clamped so it is never more than an hour away.
   * Pressable as often as somebody is there to press it — which is the point.
   */
  extend(): boolean {
    if (!this.lapsesAt) return false;
    const now = this.clock.now().getTime();
    this.lapsesAt = new Date(Math.min(Math.max(this.lapsesAt.getTime(), now) + EXTEND_MS, now + HOLD_LIMIT_MS));
    return true;
  }

  /** Forgets all of it; the gate opening is the one thing that does this. */
  reset(): void {
    this.unlockWhenDone = false;
    this.musicEnd = undefined;
    this.lapsesAt = undefined;
    this.sync();
  }

  /** Called whenever the deck, the loop setting or the gate changes. */
  sync(): void {
    const watchingMusic = this.unlockWhenDone && !this.player.getLoop() && this.player.getDeck().source === 'track';
    const wanted = watchingMusic || this.musicEnd !== undefined || this.lapsesAt !== undefined;
    if (wanted === (this.timer !== undefined)) return;
    if (wanted) {
      this.timer = setInterval(() => void this.check(), POLL_MS);
    } else {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async check(): Promise<void> {
    const now = this.clock.now();

    if (this.lapsesAt && now >= this.lapsesAt) {
      log.info('adminSession', null, 'The hold lapsed, gate released');
      await this.release(true);
      return;
    }

    const musicDue = this.musicEnd !== undefined && now >= this.musicEnd;
    // Nothing to fade when the track has already run out.
    const ranOut = this.unlockWhenDone && !this.player.getLoop()
      && this.player.getDeck().source === 'track' && this.player.hasEnded();
    if (!musicDue && !ranOut) return;

    if (this.unlockWhenDone) {
      log.info('adminSession', null, 'The music stopped, gate released', { due: musicDue });
      await this.release(musicDue);
      return;
    }

    // Note(yoochan.kim): the music was given an end but the gate was not, so only the
    // music stops. Cleared first: the restore takes a moment, and a second tick
    // landing inside it would run the whole thing twice.
    this.musicEnd = undefined;
    this.sync();
    const patch = await this.restore(true);
    this.notifier.state({ ...patch, musicEndsAt: NONE });
    log.info('adminSession', null, 'The music reached its end');
  }

  /** Puts the deck back and opens the gate — the same unwinding a manual release does. */
  private async release(fade: boolean): Promise<void> {
    this.reset();
    const patch = await this.restore(fade);
    this.lockCoordinator.setAdminLock(false);
    this.notifier.state({
      ...patch,
      loop: this.player.getLoop(),
      unlockWhenDone: false,
      musicEndsAt: NONE,
      adminHold: NONE,
    });
  }

  private async restore(fade: boolean): Promise<StatePatch> {
    if (this.player.getDeck().source !== 'track') return {};
    try {
      await this.player.restoreSong(fade);
    } catch (error) {
      log.error('adminSession', null, 'Failed to restore the song', { error: errorMessage(error) });
    }
    return {
      deck: this.player.getDeck(),
      playback: this.player.getState(),
      volume: this.player.getVolume(),
    };
  }
}

export default AdminSession;
