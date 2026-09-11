import type Player from '../player/Player.ts';
import type LockCoordinator from './LockCoordinator.ts';
import type Notifier from '../notify/Notifier.ts';
import type Clock from '../clock/Clock.ts';
import { PlaybackState } from '../protocol.ts';
import type { Deadline, MusicEnd, StatePatch } from '../protocol.ts';
import { formatInstant } from '../utils/instant.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

const POLL_MS = 1000;
/** The longest a gate a person engaged may still have to run. */
export const HOLD_LIMIT_MS = 60 * 60 * 1000;
/** What one press of extend buys. */
export const EXTEND_MS = 30 * 60 * 1000;

const NO_HOLD: Deadline = { kind: 'none' };
const UNDECIDED: MusicEnd = { kind: 'undecided' };

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
  /** Undecided until somebody says; an instant only in the third case. */
  private musicEnd: MusicEnd = UNDECIDED;
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

  musicEndsAt(): MusicEnd {
    return this.musicEnd;
  }

  /**
   * Says when the music stops.
   *
   * Note(yoochan.kim): an end past the lapse drags the lapse out with it, rather than
   * being refused. Music that was given an end gets to reach it — the same rule
   * a flow is held to — and the hour still binds, because an end may not be set
   * further out than that.
   */
  setMusicEndsAt(end: MusicEnd): void {
    this.musicEnd = end;
    if (end.kind === 'at' && this.lapsesAt) {
      const at = new Date(end.at);
      if (at > this.lapsesAt) this.lapsesAt = at;
    }
    this.sync();
  }

  adminHold(): Deadline {
    return this.lapsesAt ? { kind: 'at', at: formatInstant(this.lapsesAt) } : NO_HOLD;
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
    this.musicEnd = UNDECIDED;
    this.lapsesAt = undefined;
    this.sync();
  }

  /** Called whenever the deck, the loop setting or the gate changes. */
  sync(): void {
    const watchingMusic = this.unlockWhenDone && !this.player.getLoop() && this.player.getDeck().source === 'track';
    const wanted = watchingMusic || this.musicEnd.kind === 'at' || this.lapsesAt !== undefined;
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

    if (this.lapsesAt && now >= this.lapsesAt && !this.musicIsOwedItsEnd()) {
      log.info('adminSession', null, 'The hold lapsed, gate released');
      await this.release(true);
      return;
    }

    const musicDue = this.musicEnd.kind === 'at' && now >= new Date(this.musicEnd.at);
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
    this.musicEnd = UNDECIDED;
    this.sync();
    const patch = await this.restore(true);
    this.notifier.state({ ...patch, musicEndsAt: UNDECIDED });
    log.info('adminSession', null, 'The music reached its end');
  }

  /**
   * Whether music that is sounding still has an end coming, which the lapse waits for.
   *
   * Note(yoochan.kim): opening the panel out from under a song that is still playing is
   * the thing this avoids — the same rule a flow is held to. It can only wait
   * for an end that exists: a track that will run out, or one told when to stop.
   * Repeating music nobody gave an end to is exactly the case the hour is for,
   * so that one is let go.
   */
  private musicIsOwedItsEnd(): boolean {
    const sounding = this.player.getDeck().source === 'track' && this.player.getState() === PlaybackState.PLAYING;
    return sounding && (!this.player.getLoop() || this.musicEnd.kind === 'at');
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
      musicEndsAt: UNDECIDED,
      adminHold: NO_HOLD,
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
