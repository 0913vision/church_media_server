import { LevelFailure, LevelStage, RejectReason } from '../protocol.ts';
import type { DeckSource, LevelAnswer, LevelMatch, LevelMeter, StatePatch } from '../protocol.ts';
import type Player from '../player/Player.ts';
import type TrackLibrary from '../tracks/TrackLibrary.ts';
import type { LibraryEntry } from '../tracks/TrackLibrary.ts';
import type LockCoordinator from '../lock/LockCoordinator.ts';
import type Notifier from '../notify/Notifier.ts';
import type MixerConsole from '../console/MixerConsole.ts';
import type FlowRunner from '../flow/FlowRunner.ts';
import { DeskHeldError, DeskRestoreError } from '../console/DeskHolds.ts';
import type { DeskChange } from '../console/desk.ts';
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

class Ended extends Error {
  constructor(readonly why: LevelFailure) {
    super(why);
  }
}

/** What a person asked of a running measurement, acted on at its next tick. */
type Ask = 'pause' | 'resume' | 'apply' | 'cancel';

interface Run {
  readonly track: LibraryEntry;
  readonly meter: LevelMeter;
  readonly targetDb: number;
  readonly totalSec: number;
  /** Played to its end, rather than for a stretch of it */
  readonly whole: boolean;
  readonly volumeBefore: number;
  /** Set from outside — a hand on the desk, the server stopping — and acted on at the next tick */
  why: LevelFailure | null;
  ask: Ask | null;
  /** Stopped where it was, the deck and the desk still the measurement's */
  paused: boolean;
  /** How far it has played, whole seconds */
  elapsedSec: number;
}

/** How a measurement's body ended: played to its end, or applied or set aside while paused. */
interface Finish {
  readonly how: 'complete' | 'apply' | 'cancel';
  readonly averageDb: number | null;
}

/** What was on the deck when a measurement took it. */
interface DeckSnapshot {
  readonly deck: DeckSource;
  readonly loop: boolean;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The meter a measurement was asked for, or null for one that is not a LevelMeter. */
function meterOf(value: unknown): LevelMeter | null {
  const meter = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (meter.kind === 'output') return { kind: 'output' };
  if (meter.kind === 'main' && typeof meter.mute === 'boolean') return { kind: 'main', mute: meter.mute };
  return null;
}
const oneDecimal = (value: number): number => Math.round(value * 10) / 10;

/** Note(yoochan.kim): order is the safety: input off before play, meters before play, stopped before input back. */
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
    /** The desk while each kind of measurement runs, in the order to set it. */
    private readonly desks: { readonly output: readonly DeskChange[]; readonly mainMuted: readonly DeskChange[] },
    private readonly timing: LevelTiming,
  ) {}

  current(): LevelMatch {
    return this.status;
  }

  /** From acceptance until the deck and the desk are back, paused or not, the deck is not the panel's. */
  ownsDeck(): boolean {
    return this.run !== null;
  }

  /** A track is sounding for it; a paused one is not, so nothing waits on it. */
  isPlaying(): boolean {
    return this.run !== null && !this.run.paused;
  }

  start(args: unknown): Outcome {
    const { track: id, meter: asked, targetDb, span } = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
    if (typeof id !== 'string') return { ok: false, reason: RejectReason.INVALID_VALUE };
    const meter = meterOf(asked);
    if (!meter) return { ok: false, reason: RejectReason.INVALID_VALUE };
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

    const run: Run = { track, meter, targetDb, ...length, volumeBefore: track.volume, why: null, ask: null, paused: false, elapsedSec: 0 };
    this.run = run;
    log.info('level', null, 'Level measurement accepted', {
      track: track.id,
      meter: meter.kind === 'main' ? `main, ${meter.mute ? 'muted' : 'heard'}` : 'output',
      targetDb,
      totalSec: length.totalSec,
      volume: track.volume,
    });
    this.publish(this.progress(run, LevelStage.SETTING_DESK, SILENCE_DB, SILENCE_DB));
    void this.go(run);
    return { ok: true };
  }

  stop(): Outcome {
    const run = this.run;
    if (!run || run.paused || run.ask !== null) return { ok: false, reason: RejectReason.NOT_MEASURING };
    run.ask = 'pause';
    return { ok: true };
  }

  resume(): Outcome {
    const run = this.run;
    if (!run || !run.paused || run.ask !== null) return { ok: false, reason: RejectReason.NOT_MEASURING };
    run.ask = 'resume';
    return { ok: true };
  }

  apply(): Outcome {
    const status = this.status;
    const run = this.run;
    if (run && (!run.paused || run.ask !== null)) return { ok: false, reason: RejectReason.NOT_MEASURING };
    if (status.phase !== 'paused' && status.phase !== 'measured') return { ok: false, reason: RejectReason.NOT_MEASURING };
    if (status.answer.kind === 'none') return { ok: false, reason: RejectReason.INVALID_VALUE };
    if (status.answer.kind === 'outOfReach') return { ok: false, reason: RejectReason.OUT_OF_REACH };
    if (!this.trackLibrary.get(status.track)) return { ok: false, reason: RejectReason.UNKNOWN_TRACK };

    // Note(yoochan.kim): a paused one is ended first; the level is written once the deck and the desk are back.
    if (run) {
      run.ask = 'apply';
      return { ok: true };
    }
    this.applyAnswer(status, status.answer);
    return { ok: true };
  }

  cancel(): Outcome {
    const run = this.run;
    if (run) {
      if (!run.paused || run.ask !== null) return { ok: false, reason: RejectReason.NOT_MEASURING };
      run.ask = 'cancel';
      return { ok: true };
    }
    if (this.status.phase !== 'measured') return { ok: false, reason: RejectReason.NOT_MEASURING };
    log.info('level', null, 'Level measurement set aside', { track: this.status.track });
    this.publish({ phase: 'idle' });
    return { ok: true };
  }

  revert(): Outcome {
    const status = this.status;
    if (this.run || status.phase !== 'done') return { ok: false, reason: RejectReason.NOT_MEASURING };
    if (!this.trackLibrary.get(status.track)) return { ok: false, reason: RejectReason.UNKNOWN_TRACK };

    this.trackLibrary.setVolume(status.track, status.volumeBefore);
    log.info('level', null, 'Level put back', { track: status.track, volume: status.volumeBefore, from: status.volumeAfter });
    const { track, meter, targetDb, elapsedSec, totalSec, volumeBefore, averageDb, volumeAfter } = status;
    this.publish(
      { phase: 'measured', track, meter, targetDb, elapsedSec, totalSec, volumeBefore, answer: { kind: 'reachable', averageDb, volumeAfter } },
      { tracks: this.trackLibrary.list() },
    );
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
    const body: { finish: Finish | null } = { finish: null };
    let ended: LevelFailure | null = null;

    try {
      // Note(yoochan.kim): what the meter asks of the desk is set and read back before anything plays.
      const changes = run.meter.kind === 'output' ? this.desks.output : run.meter.mute ? this.desks.mainMuted : [];
      await this.mixer.holding(changes, async (desk) => {
        desk.onDeskChange(() => {
          run.why ??= LevelFailure.DESK_MOVED;
        });
        body.finish = await this.measure(run);
      });
    } catch (error) {
      if (error instanceof Ended) {
        ended = error.why;
      } else if (error instanceof DeskHeldError) {
        ended = LevelFailure.DESK_HELD;
      } else if (error instanceof DeskRestoreError) {
        // Note(yoochan.kim): the answer stands; DeskHolds keeps retrying the restore, the console showing the desk.
        log.error('level', null, 'Measured, but the desk is not put back yet', { track: run.track.id });
      } else {
        log.error('level', null, 'The desk could not be set aside', { track: run.track.id, error: errorMessage(error) });
        ended = LevelFailure.DESK_SILENT;
      }
    }

    this.run = null;
    const finish = body.finish;
    if (ended === null && finish === null) ended = LevelFailure.DESK_SILENT;
    if (ended === null && finish?.how === 'complete' && finish.averageDb === null) ended = LevelFailure.NO_SIGNAL;
    if (ended !== null || finish === null) {
      const why = ended ?? LevelFailure.DESK_SILENT;
      log.warn('level', null, 'Level measurement ended without an answer', { track: run.track.id, why, at: run.elapsedSec });
      this.publish({
        phase: 'failed', track: run.track.id, meter: run.meter, targetDb: run.targetDb,
        elapsedSec: run.elapsedSec, totalSec: run.totalSec, volumeBefore: run.volumeBefore, why,
      });
      return;
    }

    if (finish.how === 'cancel') {
      log.info('level', null, 'Level measurement set aside', { track: run.track.id, at: run.elapsedSec });
      this.publish({ phase: 'idle' });
      return;
    }
    const measured = { ...this.resultOf(run), answer: this.answerOf(run, finish.averageDb) } as const;
    if (finish.how === 'apply' && measured.answer.kind === 'reachable') {
      this.applyAnswer(measured, measured.answer);
      return;
    }
    // Note(yoochan.kim): the answer spelled out, since a measurement set aside afterwards is gone from everywhere but here.
    const { answer } = measured;
    log.info('level', null, 'Measured; waiting to be applied', {
      track: run.track.id, meter: measured.meter.kind, targetDb: measured.targetDb, at: run.elapsedSec, from: measured.volumeBefore,
      answer: answer.kind,
      ...(answer.kind === 'none' ? {} : { averageDb: answer.averageDb }),
      ...(answer.kind === 'reachable' ? { volume: answer.volumeAfter } : answer.kind === 'outOfReach' ? { needed: answer.volumeNeeded } : {}),
    });
    this.publish({ phase: 'measured', ...measured });
  }

  private applyAnswer(
    result: Omit<Extract<LevelMatch, { phase: 'measured' }>, 'phase' | 'answer'>,
    answer: Extract<LevelAnswer, { kind: 'reachable' }>,
  ): void {
    this.trackLibrary.setVolume(result.track, answer.volumeAfter);
    log.info('level', null, 'Measured level applied', { track: result.track, averageDb: answer.averageDb, from: result.volumeBefore, volume: answer.volumeAfter });
    const { track, meter, targetDb, elapsedSec, totalSec, volumeBefore } = result;
    this.publish(
      { phase: 'done', track, meter, targetDb, elapsedSec, totalSec, averageDb: answer.averageDb, volumeBefore, volumeAfter: answer.volumeAfter },
      { tracks: this.trackLibrary.list() },
    );
  }

  /** Plays the track at the desk and reads its meter until it ends or a person ends it. Runs inside the hold, and stops the track before leaving it. */
  private async measure(run: Run): Promise<Finish> {
    const meter = new MeterAverage();
    let lastFrameAt = 0;
    let listening = false;
    const stopMeters = this.mixer.watchMeters(run.meter.kind, (levels) => {
      lastFrameAt = Date.now();
      if (listening) meter.add(levels, lastFrameAt);
    });

    try {
      const askedAt = Date.now();
      // Note(yoochan.kim): nothing plays until the desk sends meters, so the mock, which has none, never plays one.
      while (lastFrameAt === 0) {
        this.check(run);
        if (Date.now() - askedAt >= this.timing.METER_WAIT_MS) throw new Ended(LevelFailure.DESK_SILENT);
        await delay(this.timing.TICK_MS);
      }
      this.check(run);
      const gainDb = await this.mixer.meterGainDb(run.meter.kind).catch(() => {
        throw new Ended(LevelFailure.DESK_SILENT);
      });
      const averageDb = (): number | null => {
        const average = meter.averageDb();
        return average === null ? null : average + gainDb;
      };

      const found: DeckSnapshot = { deck: this.player.getDeck(), loop: this.player.getLoop() };
      let started = false;
      let playedMs = 0;
      let playingSince: number | null = null;
      const elapsedSec = (now: number): number => (playedMs + (playingSince === null ? 0 : now - playingSince)) / 1000;

      // Note(yoochan.kim): a resumed track fades in, so the meter counts again only once the fade is over.
      const play = async (): Promise<void> => {
        playingSince = Date.now();
        const sounding = await this.withAudio(started
          ? () => this.player.play()
          : () => this.player.playTrackAt(run.track, 0, run.track.volume, false));
        if (!sounding) throw new Ended(LevelFailure.DECK_FAILED);
        started = true;
        run.paused = false;
        listening = true;
        this.tellDeck();
      };
      const pause = async (): Promise<void> => {
        listening = false;
        if (started && !(await this.withAudio(() => this.player.cut()))) throw new Ended(LevelFailure.DECK_FAILED);
        if (playingSince !== null) playedMs += Date.now() - playingSince;
        playingSince = null;
        run.paused = true;
        run.elapsedSec = Math.floor(elapsedSec(Date.now()));
        this.tellDeck();
        log.info('level', null, 'Level measurement paused', { track: run.track.id, at: run.elapsedSec });
        this.publish({ phase: 'paused', ...this.resultOf(run), answer: this.answerOf(run, averageDb()) });
      };

      try {
        // Note(yoochan.kim): stopped while the desk was being set, so nothing has sounded yet.
        if (run.ask === 'pause') {
          this.takeAsk(run);
          await pause();
        } else {
          await play();
        }

        let toldAt = 0;
        for (;;) {
          await delay(this.timing.TICK_MS);
          this.check(run);
          const now = Date.now();
          if (now - lastFrameAt > this.timing.METER_SILENCE_MS) throw new Ended(LevelFailure.DESK_SILENT);

          const ask = this.takeAsk(run);
          if (ask === 'apply' || ask === 'cancel') return { how: ask, averageDb: averageDb() };
          if (run.paused) {
            if (ask !== 'resume') continue;
            log.info('level', null, 'Level measurement resumed', { track: run.track.id, at: run.elapsedSec });
            await play();
            toldAt = 0;
          }

          const played = elapsedSec(Date.now());
          run.elapsedSec = Math.min(Math.floor(played), Math.floor(run.totalSec));
          const over = run.whole
            ? this.player.hasEnded() || played >= run.totalSec + this.timing.END_SLACK_SEC
            : played >= run.totalSec;
          if (over) {
            // Note(yoochan.kim): rounded as a screen rounds the length, so a whole track reads 6:02 / 6:02.
            run.elapsedSec = Math.round(run.totalSec);
            return { how: 'complete', averageDb: averageDb() };
          }
          if (ask === 'pause') {
            await pause();
            continue;
          }

          if (Date.now() - toldAt >= this.timing.PROGRESS_INTERVAL_MS) {
            toldAt = Date.now();
            const told = (db: number | null): number => Math.max(SILENCE_DB, oneDecimal(db === null ? SILENCE_DB : db + gainDb));
            const recent = meter.recentDb(this.timing.RECENT_SEC);
            const average = meter.averageDb();
            this.publish(this.progress(run, LevelStage.PLAYING, told(recent), told(average)));
          }
        }
      } catch (error) {
        if (error instanceof Ended) throw error;
        log.error('level', null, 'The deck could not play the track', { track: run.track.id, error: errorMessage(error) });
        throw new Ended(LevelFailure.DECK_FAILED);
      } finally {
        listening = false;
        await this.giveBack(found);
      }
    } finally {
      stopMeters();
    }
  }

  /** A person's request, taken once; a command may set it between any two ticks. */
  private takeAsk(run: Run): Ask | null {
    const ask = run.ask;
    run.ask = null;
    return ask;
  }

  /** Throws Ended when the measurement has lost what it needs: its gate, or its deck. */
  private check(run: Run): void {
    if (run.why) throw new Ended(run.why);
    if (this.lockCoordinator.adminGateHeldBy() !== 'person') throw new Ended(LevelFailure.GATE_RELEASED);
    if (this.flowRunner.ownsDeck()) throw new Ended(LevelFailure.DECK_TAKEN);
  }

  /** Note(yoochan.kim): a run that took the gate, or a release that already put the song back, owns the deck by now. */
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
      // Note(yoochan.kim): the track must stop before the input comes back on the desk; that outranks the lock.
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

  private tellDeck(): void {
    this.notifier.state({
      deck: this.player.getDeck(),
      playback: this.player.getState(),
      volume: this.player.getVolume(),
    });
  }

  private async withAudio(work: () => Promise<void>): Promise<boolean> {
    for (let attempt = 1; attempt <= AUDIO_ATTEMPTS; attempt += 1) {
      if (await this.lockCoordinator.withAudioLock(true, work)) return true;
      await delay(AUDIO_RETRY_MS);
    }
    return false;
  }

  /** What the average so far says the track's level should be. */
  private answerOf(run: Run, averageDb: number | null): LevelAnswer {
    if (averageDb === null) return { kind: 'none' };
    const needed = volumeFor(run.volumeBefore, averageDb, run.targetDb);
    const volumeAfter = Math.round(needed);
    if (volumeAfter < LEVEL_CONFIG.VOLUME.MIN || volumeAfter > LEVEL_CONFIG.VOLUME.MAX) {
      return { kind: 'outOfReach', averageDb: oneDecimal(averageDb), volumeNeeded: oneDecimal(needed) };
    }
    return { kind: 'reachable', averageDb: oneDecimal(averageDb), volumeAfter };
  }

  private resultOf(run: Run) {
    return {
      track: run.track.id, meter: run.meter, targetDb: run.targetDb,
      elapsedSec: run.elapsedSec, totalSec: run.totalSec, volumeBefore: run.volumeBefore,
    };
  }

  private progress(run: Run, stage: LevelStage, levelDb: number, averageDb: number): LevelMatch {
    return {
      phase: 'measuring', track: run.track.id, meter: run.meter, targetDb: run.targetDb, stage,
      elapsedSec: run.elapsedSec, totalSec: run.totalSec, levelDb, averageDb,
    };
  }

  private publish(status: LevelMatch, alongside: StatePatch = {}): void {
    this.status = status;
    this.notifier.state({ ...alongside, levelMatch: status });
  }
}

export default LevelMatcher;
