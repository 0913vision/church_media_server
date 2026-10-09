import { LevelFailure, RejectReason } from '../protocol.ts';
import type { DeckSource, LevelMatch, StatePatch } from '../protocol.ts';
import type Player from '../player/Player.ts';
import type TrackLibrary from '../tracks/TrackLibrary.ts';
import type { LibraryEntry } from '../tracks/TrackLibrary.ts';
import type LockCoordinator from '../lock/LockCoordinator.ts';
import type Notifier from '../notify/Notifier.ts';
import type MixerConsole from '../console/MixerConsole.ts';
import type FlowRunner from '../flow/FlowRunner.ts';
import { DeskHeldError, DeskRestoreError } from '../console/DeskHolds.ts';
import { off } from '../console/desk.ts';
import { LEVEL_CONFIG } from '../constants/levelConfig.ts';
import type { LevelTiming } from '../constants/levelConfig.ts';
import { MeterAverage, volumeFor } from './meterAverage.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

type Outcome = { ok: true } | { ok: false; reason: RejectReason };

/** Silence, as levelDb says it */
const SILENCE_DB = -120;
/** How often taking the audio device is tried before a measurement gives up on it */
const AUDIO_ATTEMPTS = 12;
const AUDIO_RETRY_MS = 300;

/** A measurement ending early, and why. */
class Ended extends Error {
  constructor(readonly why: LevelFailure) {
    super(why);
  }
}

interface Run {
  readonly track: LibraryEntry;
  readonly targetDb: number;
  readonly totalSec: number;
  /** Played to its end, rather than for a stretch of it */
  readonly whole: boolean;
  /** Set from outside — a stop, a hand on the desk — and acted on at the next tick */
  why: LevelFailure | null;
}

/** What was on the deck when a measurement took it. */
interface DeckSnapshot {
  readonly deck: DeckSource;
  readonly loop: boolean;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const oneDecimal = (value: number): number => Math.round(value * 10) / 10;

/**
 * Measures a track on the desk and moves its level onto a target.
 *
 * Note(yoochan.kim): the order is the safety. The music player's input is switched
 * off on the desk and read back first (a DeskHolds hold); the desk has to be
 * sending meters before anything plays; and the track has stopped before the
 * hold puts the input back. So the room never hears a measurement, and a desk
 * that cannot be set aside — the mock among them, which has no meters — never
 * gets one played at it at all.
 */
class LevelMatcher {
  private status: LevelMatch = { phase: 'idle' };
  private run: Run | null = null;

  constructor(
    private readonly player: Player,
    private readonly trackLibrary: TrackLibrary,
    private readonly lockCoordinator: LockCoordinator,
    private readonly notifier: Notifier,
    private readonly mixer: MixerConsole,
    private readonly flowRunner: Pick<FlowRunner, 'ownsDeck'>,
    private readonly timing: LevelTiming,
  ) {}

  current(): LevelMatch {
    return this.status;
  }

  /** From acceptance until the deck and the desk are back, the deck is not the panel's. */
  ownsDeck(): boolean {
    return this.run !== null;
  }

  start(args: unknown): Outcome {
    const { track: id, targetDb, span } = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
    if (typeof id !== 'string') return { ok: false, reason: RejectReason.INVALID_VALUE };
    const { MIN, MAX } = LEVEL_CONFIG.TARGET_DB;
    if (typeof targetDb !== 'number' || !Number.isFinite(targetDb) || targetDb < MIN || targetDb > MAX) {
      return { ok: false, reason: RejectReason.INVALID_VALUE };
    }

    const holder = this.lockCoordinator.adminGateHeldBy();
    if (holder === null) return { ok: false, reason: RejectReason.ADMIN_UNLOCKED };
    if (holder === 'flow' || this.flowRunner.ownsDeck()) return { ok: false, reason: RejectReason.FLOW_ACTIVE };
    if (this.run) return { ok: false, reason: RejectReason.LEVEL_MATCHING };
    if (this.player.isPlaying()) return { ok: false, reason: RejectReason.DECK_PLAYING };
    if (this.player.isMuted()) return { ok: false, reason: RejectReason.DECK_MUTED };

    const track = this.trackLibrary.get(id);
    if (!track) return { ok: false, reason: RejectReason.UNKNOWN_TRACK };
    const length = this.lengthOf(span, track.durationSec);
    if (!length) return { ok: false, reason: RejectReason.INVALID_VALUE };

    const run: Run = { track, targetDb, ...length, why: null };
    this.run = run;
    log.info('level', null, 'Level measurement accepted', {
      track: track.id,
      targetDb,
      totalSec: length.totalSec,
      volume: track.volume,
    });
    this.publish(this.progress(run, 0, SILENCE_DB));
    void this.go(run);
    return { ok: true };
  }

  stop(): Outcome {
    if (!this.run) return { ok: false, reason: RejectReason.NOT_MEASURING };
    this.run.why ??= LevelFailure.STOPPED;
    return { ok: true };
  }

  dispose(): void {
    if (this.run) this.run.why ??= LevelFailure.STOPPED;
  }

  private lengthOf(span: unknown, durationSec: number): { totalSec: number; whole: boolean } | null {
    if (typeof span !== 'object' || span === null) return null;
    const { kind, sec } = span as Record<string, unknown>;
    if (kind === 'whole') return { totalSec: durationSec, whole: true };
    if (kind !== 'first' || typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return null;
    return sec >= durationSec ? { totalSec: durationSec, whole: true } : { totalSec: sec, whole: false };
  }

  private async go(run: Run): Promise<void> {
    const volumeBefore = run.track.volume;
    const measured: { averageDb: number | null } = { averageDb: null };
    let ended: LevelFailure | null = null;

    try {
      await this.mixer.holding([off(LEVEL_CONFIG.STRIP)], async (desk) => {
        desk.onDeskChange(() => {
          run.why ??= LevelFailure.DESK_MOVED;
        });
        measured.averageDb = await this.measure(run);
      });
    } catch (error) {
      if (error instanceof Ended) {
        ended = error.why;
      } else if (error instanceof DeskHeldError) {
        ended = LevelFailure.DESK_HELD;
      } else if (error instanceof DeskRestoreError) {
        // Note(yoochan.kim): the answer stands; the desk keeps being asked to take its
        // old value back, and the console attribute shows the input still off meanwhile.
        log.error('level', null, 'Measured, but the desk is not put back yet', { track: run.track.id });
      } else {
        log.error('level', null, 'The desk could not be set aside', { track: run.track.id, error: errorMessage(error) });
        ended = LevelFailure.DESK_SILENT;
      }
    }

    this.run = null;
    const averageDb = measured.averageDb;
    if (ended === null && averageDb === null) ended = LevelFailure.NO_SIGNAL;
    if (ended !== null || averageDb === null) {
      const why = ended ?? LevelFailure.NO_SIGNAL;
      log.warn('level', null, 'Level measurement ended without an answer', { track: run.track.id, why });
      this.publish({ phase: 'failed', track: run.track.id, why });
      return;
    }

    const needed = volumeFor(volumeBefore, averageDb, run.targetDb);
    const volumeAfter = Math.round(needed);
    const result = { track: run.track.id, targetDb: run.targetDb, averageDb: oneDecimal(averageDb), volumeBefore };
    if (volumeAfter < LEVEL_CONFIG.VOLUME.MIN || volumeAfter > LEVEL_CONFIG.VOLUME.MAX) {
      log.info('level', null, 'Measured; the target is out of reach', { ...result, volumeNeeded: oneDecimal(needed) });
      this.publish({ phase: 'outOfReach', ...result, volumeNeeded: oneDecimal(needed) });
      return;
    }
    this.trackLibrary.setVolume(run.track.id, volumeAfter);
    log.info('level', null, 'Measured; level moved', { ...result, volumeAfter });
    this.publish({ phase: 'done', ...result, volumeAfter }, { tracks: this.trackLibrary.list() });
  }

  /** Plays the track at the desk and reads its meter. Runs inside the hold, and stops the track before leaving it. */
  private async measure(run: Run): Promise<number | null> {
    const meter = new MeterAverage();
    let lastFrameAt = 0;
    let listening = false;
    const stopMeters = this.mixer.watchMeters((levels) => {
      lastFrameAt = Date.now();
      if (listening) meter.add(levels, lastFrameAt);
    });

    try {
      const askedAt = Date.now();
      while (lastFrameAt === 0) {
        this.check(run);
        if (Date.now() - askedAt >= this.timing.METER_WAIT_MS) throw new Ended(LevelFailure.DESK_SILENT);
        await delay(this.timing.TICK_MS);
      }
      this.check(run);

      const found: DeckSnapshot = { deck: this.player.getDeck(), loop: this.player.getLoop() };
      try {
        const played = await this.withAudio(() => this.player.playTrackAt(run.track, 0, run.track.volume, false));
        if (!played) throw new Ended(LevelFailure.DECK_FAILED);
        listening = true;
        this.notifier.state({
          deck: this.player.getDeck(),
          playback: this.player.getState(),
          volume: this.player.getVolume(),
        });
        await this.listen(run, meter, () => lastFrameAt);
      } catch (error) {
        if (error instanceof Ended) throw error;
        log.error('level', null, 'The deck could not play the track', { track: run.track.id, error: errorMessage(error) });
        throw new Ended(LevelFailure.DECK_FAILED);
      } finally {
        listening = false;
        await this.giveBack(found);
      }
      return meter.averageDb();
    } finally {
      stopMeters();
    }
  }

  /** Waits out the measurement, telling every screen how it goes. Throws Ended when something ends it early. */
  private async listen(run: Run, meter: MeterAverage, lastFrameAt: () => number): Promise<void> {
    const startedAt = Date.now();
    let toldAt = startedAt;
    for (;;) {
      await delay(this.timing.TICK_MS);
      this.check(run);
      const now = Date.now();
      if (now - lastFrameAt() > this.timing.METER_SILENCE_MS) throw new Ended(LevelFailure.DESK_SILENT);

      const elapsedSec = (now - startedAt) / 1000;
      const over = run.whole
        ? this.player.hasEnded() || elapsedSec >= run.totalSec + this.timing.END_SLACK_SEC
        : elapsedSec >= run.totalSec;
      if (over) return;

      if (now - toldAt >= this.timing.PROGRESS_INTERVAL_MS) {
        toldAt = now;
        const levelDb = meter.recentDb(this.timing.RECENT_SEC) ?? SILENCE_DB;
        this.publish(this.progress(run, Math.floor(elapsedSec), Math.max(SILENCE_DB, oneDecimal(levelDb))));
      }
    }
  }

  /** Throws Ended when the measurement has lost what it needs: its gate, or its deck. */
  private check(run: Run): void {
    if (run.why) throw new Ended(run.why);
    if (this.lockCoordinator.adminGateHeldBy() !== 'person') throw new Ended(LevelFailure.GATE_RELEASED);
    if (this.flowRunner.ownsDeck()) throw new Ended(LevelFailure.DECK_TAKEN);
  }

  /**
   * Puts the deck back the way the measurement found it: the user's song, or the
   * library track a person had put on, with their loop setting.
   *
   * Note(yoochan.kim): unless something else has the deck by now. A run that took
   * the gate has its own music to play, and releasing the gate has already put
   * the song back; either way the deck is no longer the measurement's to touch.
   */
  private async giveBack(found: DeckSnapshot): Promise<void> {
    const ours = this.player.getDeck().source === 'track'
      && !this.flowRunner.ownsDeck()
      && this.lockCoordinator.adminGateHeldBy() !== 'flow';
    if (!ours) return;

    const putBack = async (): Promise<void> => {
      await this.player.restoreSong(false);
      this.player.setLoop(found.loop);
      if (found.deck.source !== 'track') return;
      const before = this.trackLibrary.get(found.deck.id);
      if (before) await this.player.selectTrack(before, before.volume, found.loop);
    };
    if (!(await this.withAudio(putBack))) {
      // Note(yoochan.kim): the track has to stop before the desk takes the input
      // back, and that outranks waiting for the lock.
      log.error('level', null, 'The audio device stayed busy; putting the deck back without it');
      await putBack();
    }
    this.notifier.state({
      deck: this.player.getDeck(),
      playback: this.player.getState(),
      volume: this.player.getVolume(),
      loop: this.player.getLoop(),
    });
  }

  private async withAudio(work: () => Promise<void>): Promise<boolean> {
    for (let attempt = 1; attempt <= AUDIO_ATTEMPTS; attempt += 1) {
      if (await this.lockCoordinator.withAudioLock(true, work)) return true;
      await delay(AUDIO_RETRY_MS);
    }
    return false;
  }

  private progress(run: Run, elapsedSec: number, levelDb: number): LevelMatch {
    return { phase: 'measuring', track: run.track.id, targetDb: run.targetDb, elapsedSec, totalSec: run.totalSec, levelDb };
  }

  private publish(status: LevelMatch, alongside: StatePatch = {}): void {
    this.status = status;
    this.notifier.state({ ...alongside, levelMatch: status });
  }
}

export default LevelMatcher;
