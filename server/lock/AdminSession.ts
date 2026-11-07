import type Player from '../player/Player.ts';
import type LockCoordinator from './LockCoordinator.ts';
import type Notifier from '../notify/Notifier.ts';
import type Clock from '../clock/Clock.ts';
import type LevelMatcher from '../level/LevelMatcher.ts';
import { PlaybackState } from '../protocol.ts';
import type { Deadline, MusicEnd, StatePatch } from '../protocol.ts';
import { formatInstant } from '../utils/instant.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

const POLL_MS = 1000;
/** The longest a gate a person engaged may still have to run. */
export const HOLD_LIMIT_MS = 60 * 60 * 1000;
export const EXTEND_MS = 30 * 60 * 1000;

const NO_HOLD: Deadline = { kind: 'none' };
const UNDECIDED: MusicEnd = { kind: 'undecided' };

/** Note(yoochan.kim): looping music and a person gone home would both hold the gate forever, so both get an end. */
class AdminSession {
  private unlockWhenDone = false;
  private musicEnd: MusicEnd = UNDECIDED;
  private lapsesAt: Date | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly player: Player,
    private readonly lockCoordinator: LockCoordinator,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
    private readonly levelMatcher: Pick<LevelMatcher, 'isPlaying'>,
  ) {}

  isArmed(): boolean {
    return this.unlockWhenDone;
  }

  setUnlockWhenDone(armed: boolean): void {
    this.unlockWhenDone = armed;
    this.sync();
  }

  musicEndsAt(): MusicEnd {
    return this.musicEnd;
  }

  /** Note(yoochan.kim): an end past the lapse drags it out, as with a flow; the end itself is capped at an hour. */
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

  /** Called when a person engages the gate, never for a flow. */
  engage(): void {
    this.lapsesAt = new Date(this.clock.now().getTime() + HOLD_LIMIT_MS);
    this.sync();
  }

  /** Clamped to an hour from now, so it can be pressed as often as somebody is there to press it. */
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
    // Note(yoochan.kim): a run outranks a person's hold; acting on it would open the run's gate under its music.
    if (this.lockCoordinator.adminGateHeldBy() !== 'person') {
      if (this.lapsesAt) {
        log.info('adminSession', null, 'A run took the gate; the hold is over');
        this.reset();
        this.notifier.state({ musicEndsAt: UNDECIDED, adminHold: NO_HOLD });
      }
      return;
    }

    // Note(yoochan.kim): the lapse waits for a measurement's track to end, but not for one left paused with the desk held.
    if (this.levelMatcher.isPlaying()) return;

    const now = this.clock.now();

    if (this.lapsesAt && now >= this.lapsesAt && !this.musicIsOwedItsEnd()) {
      log.info('adminSession', null, 'The hold lapsed, gate released');
      await this.release(true);
      return;
    }

    const musicDue = this.musicEnd.kind === 'at' && now >= new Date(this.musicEnd.at);
    // Note(yoochan.kim): nothing to fade when the track has already run out.
    const ranOut = this.unlockWhenDone && !this.player.getLoop()
      && this.player.getDeck().source === 'track' && this.player.hasEnded();
    if (!musicDue && !ranOut) return;

    if (this.unlockWhenDone) {
      log.info('adminSession', null, 'The music stopped, gate released', { due: musicDue });
      await this.release(musicDue);
      return;
    }

    // Note(yoochan.kim): cleared first, since a tick landing inside the slow restore would run all of this twice.
    this.musicEnd = UNDECIDED;
    this.sync();
    const patch = await this.restore(true);
    this.notifier.state({ ...patch, musicEndsAt: UNDECIDED });
    log.info('adminSession', null, 'The music reached its end');
  }

  /** Note(yoochan.kim): the lapse waits for music that will end; music looping with no end is what the hour is for. */
  private musicIsOwedItsEnd(): boolean {
    const sounding = this.player.getDeck().source === 'track' && this.player.getState() === PlaybackState.PLAYING;
    return sounding && (!this.player.getLoop() || this.musicEnd.kind === 'at');
  }

  /** The same unwinding a manual release does. */
  private async release(fade: boolean): Promise<void> {
    // Note(yoochan.kim): only ever this session's own gate; check() has already established that.
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
