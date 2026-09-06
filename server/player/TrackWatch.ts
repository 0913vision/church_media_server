import type Player from './Player.ts';
import type LockCoordinator from '../lock/LockCoordinator.ts';
import type Notifier from '../notify/Notifier.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

/** How often the deck is asked whether it has run out. */
const POLL_MS = 1000;

/**
 * Releases the gate when the track an admin put on reaches its end.
 *
 * For putting one piece on and walking away: the deck goes back to the user's
 * song and the panel comes alive without anyone returning to the desk. The end
 * is asked of the device rather than timed, because a track can sit paused.
 *
 * Note(yoochan.kim): the poll runs only while it is wanted — a track on the deck, not
 * repeating, with this switched on — and stops the moment any of those stops
 * being true.
 */
class TrackWatch {
  private armed = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly player: Player,
    private readonly lockCoordinator: LockCoordinator,
    private readonly notifier: Notifier,
  ) {}

  isArmed(): boolean {
    return this.armed;
  }

  set(armed: boolean): void {
    this.armed = armed;
    this.sync();
  }

  /** Called whenever the deck or the loop setting changes. */
  sync(): void {
    const wanted = this.armed && !this.player.getLoop() && this.player.getDeck().source === 'track';
    if (wanted === (this.timer !== undefined)) return;
    if (wanted) {
      this.timer = setInterval(() => void this.check(), POLL_MS);
    } else {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Forgets the setting entirely; the gate opening is the one thing that does this. */
  reset(): void {
    this.armed = false;
    this.sync();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async check(): Promise<void> {
    if (!this.player.hasEnded()) return;
    // Note(yoochan.kim): disarmed first. The restore takes a moment, and a second tick
    // landing inside it would run the whole thing twice.
    this.reset();

    try {
      // Nothing to fade: the track has already run out.
      await this.player.restoreSong(false);
    } catch (error) {
      log.error('trackWatch', null, 'Failed to restore the song after a track ended', {
        error: errorMessage(error),
      });
    }
    this.lockCoordinator.setAdminLock(false);
    this.notifier.state({
      deck: this.player.getDeck(),
      playback: this.player.getState(),
      volume: this.player.getVolume(),
      loop: this.player.getLoop(),
      unlockWhenDone: false,
    });
    log.info('trackWatch', null, 'Track ended, gate released');
  }
}

export default TrackWatch;
