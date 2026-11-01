import { RejectReason } from '../protocol.ts';
import type { FlowStatus, FlowTrack } from '../protocol.ts';
import type Player from '../player/Player.ts';
import type { SongId } from '../constants/songs.ts';
import type TrackLibrary from '../tracks/TrackLibrary.ts';
import type { LibraryEntry } from '../tracks/TrackLibrary.ts';
import type LockCoordinator from '../lock/LockCoordinator.ts';
import type Notifier from '../notify/Notifier.ts';
import type Clock from '../clock/Clock.ts';
import type { FlowTiming } from '../constants/flowConfig.ts';
import type MixerConsole from '../console/MixerConsole.ts';
import type { DeskChange } from '../console/desk.ts';
import { DeskRestoreError } from '../console/DeskHolds.ts';
import { log } from '../utils/logger.ts';
import { formatInstant, isWireInstant } from '../utils/instant.ts';
import { errorMessage } from '../utils/errors.ts';

/** Result of checking part of a request */
type Checked<T> = { ok: true; value: T } | { ok: false; reason: RejectReason };


// Note(yoochan.kim): A flow's own audio work can collide with an admin writing at the same
// moment. Contention lasts at most one fade, so retry across that window
// rather than dropping a track.
const AUDIO_LOCK_ATTEMPTS = 12;
const AUDIO_LOCK_RETRY_MS = 300;

/** A library track as one flow scheduled it: same audio, that flow's level */
type ScheduledEntry = LibraryEntry;

/** One clip of a countdown, played on its own second: 1분 남았습니다, the count. */
export interface CuePlan {
  track: ScheduledEntry;
  at: Date;
}

/**
 * A countdown: the count, always, and whichever notices were ticked ahead of it
 * (1분 전, 30초 전), each played on its own second. It is one block, from
 * `reserveMs(timing)` before its first notice to the end of the count: nothing
 * else sounds in it, and a flow that holds one is never started once under way.
 * Not on the wire yet.
 */
export interface CountdownPlan {
  kind: 'countdown';
  cues: CuePlan[];
  /**
   * The desk for the whole block, in the order to set it — CONSOLE_CONFIG.BAND_ONLY.
   * Set and read back as the block opens, put back newest first once the count has
   * ended. A countdown whose desk cannot be set is not played.
   */
  desk?: readonly DeskChange[];
}

/** A clip that could not take the audio device: the countdown gives up, as music does. */
class CueFailed extends Error {}

type MusicPlan = { kind: 'music'; tracks: ScheduledEntry[]; startsAt: Date; endsAt: Date };
/** A part of a validated plan: the protocol's FlowPart, and the countdown, which it does not carry yet */
export type PartPlan = MusicPlan | CountdownPlan;

/** The window this run holds the admin gate for. Every run has one. */
interface LockPlan {
  at: Date;
  until: Date;
}

export interface Plan {
  /** The caller's own identifier, handed straight back on every status. */
  id: string;
  name: string;
  lock: LockPlan;
  parts: PartPlan[];
}

/** Thrown into pending waits when a run is stopped */
class FlowAborted extends Error {}

interface Waiter {
  cancel(): void;
}

interface ActiveRun {
  plan: Plan;
  startsAt: Date;
  lockEngaged: boolean;
  playing: { track: FlowTrack; endsAt: Date } | undefined;
  finished: Promise<void>;
  /**
   * The deck as it was when this run was accepted, and what it goes back to.
   *
   * Note(yoochan.kim): taken once, at the start — not read again at the end. The panel is
   * usable while a run is only holding the gate, and anything done there belongs
   * to the person who did it, not to what the service should return to. Someone
   * putting a track on during the quiet half must not decide what plays after.
   */
  restorePoint: { song: SongId; volume: number };
  /**
   * Whether the run has the deck: from its first sound until its last has ended,
   * the quiet between them included, so nothing else plays in a gap it keeps.
   */
  deckHeld: boolean;
  /** Parts still to finish sounding; the one that brings this to none puts the deck back. */
  partsLeft: number;
  /** A countdown notice is sounding. A stop cuts it at once, before its desk goes back. */
  cueSounding: boolean;
}

/**
 * An absolute instant, or a refusal.
 *
 * Only ISO 8601 with a date is accepted. A bare "19:30" would leave the server
 * deciding which day it meant, and that guess is the caller's to make: the
 * calendar lives on the client that submitted the run.
 */
function instantOf(value: unknown): Checked<Date> {
  // Note(yoochan.kim): one spelling only — see server/utils/instant.ts. Date
  // would happily take "2026-08-05" and a dozen other forms, and every one it
  // accepts is a form some client could come to depend on.
  if (!isWireInstant(value)) return { ok: false, reason: RejectReason.INVALID_VALUE };
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return { ok: false, reason: RejectReason.INVALID_VALUE };
  return { ok: true, value: at };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one flow at a time and owns it from the moment it is accepted until it
 * is finished, stopped, or fails. The schedule a flow came from is none of the
 * server's business: it holds no definitions and no calendar, only the run.
 *
 * Every run holds the admin gate for a window it names: music playing on an
 * open panel could be taken over from the tablet mid-run, so the gate is not
 * optional. Music must finish inside that window, but its timeline may begin
 * earlier — sound waits for the lock and joins the timeline where it already
 * is, the opening cut exactly like a late start. Within the window the lock
 * and the music timeline each keep to the wall clock on their own, and the
 * run ends when both are done. Whatever ends it, cleanup restores the user's
 * song and releases the lock, so a lock can never outlive the client that asked
 * for it.
 */
class FlowRunner {
  private active: ActiveRun | undefined;
  private readonly waiters = new Set<Waiter>();

  constructor(
    private readonly player: Player,
    private readonly trackLibrary: TrackLibrary,
    private readonly lockCoordinator: LockCoordinator,
    private readonly notifier: Notifier,
    // Note(yoochan.kim): Every instant in a plan is church time, so the runner never reads the
    // system clock directly.
    private readonly clock: Clock,
    private readonly mixer: Pick<MixerConsole, 'holding'>,
    private readonly timing: FlowTiming,
  ) {}

  /**
   * What the flow slot is doing. Derived from the run rather than stored, so
   * it cannot drift from what is actually happening.
   */
  status(): FlowStatus {
    const run = this.active;
    if (!run) return { phase: 'idle' };

    const { id, name } = run.plan;
    if (run.playing) {
      return { phase: 'playing', id, name, track: run.playing.track, endsAt: formatInstant(run.playing.endsAt) };
    }
    if (run.lockEngaged) {
      return { phase: 'holding', id, name, unlockAt: formatInstant(run.plan.lock.until) };
    }
    return { phase: 'waiting', id, name, startsAt: formatInstant(run.startsAt) };
  }

  /** Whether a running flow is the one holding the admin lock */
  ownsAdminLock(): boolean {
    return this.active?.lockEngaged ?? false;
  }

  /**
   * Whether a run has the deck right now.
   *
   * Note(yoochan.kim): from its first sound until its last has ended, not merely while
   * the gate is held. A flow that only holds the gate is keeping the panel out;
   * the deck is still free until the run's own sound begins.
   */
  ownsDeck(): boolean {
    return this.active?.deckHeld ?? false;
  }

  /**
   * Whether the run in flight names this track.
   *
   * Note(yoochan.kim): a run copied its tracks when it was accepted, so a calendar edited
   * since then no longer says what the run is about to play.
   */
  uses(trackId: string): boolean {
    return this.active?.plan.parts.some((part) => tracksOf(part).some((track) => track.id === trackId)) ?? false;
  }

  /** Accepts a flow and starts running it. */
  async start(args: unknown): Promise<{ ok: true } | { ok: false; reason: RejectReason }> {
    if (this.active) return { ok: false, reason: RejectReason.FLOW_ACTIVE };

    const planned = this.planOf(args);
    if (!planned.ok) return planned;
    this.begin(planned.value);
    return { ok: true };
  }

  /**
   * Runs a plan built inside the server, a countdown included — the door it comes
   * in by until the protocol carries it. Refused like start, and for a timeline
   * whose sounds would overlap or fall outside the gate.
   */
  startPlan(plan: Plan): { ok: true } | { ok: false; reason: RejectReason | TimelineConflict | 'countdownUnderway' } {
    if (this.active) return { ok: false, reason: RejectReason.FLOW_ACTIVE };
    const now = this.clock.now().getTime();
    if (plan.lock.until.getTime() <= now) return { ok: false, reason: RejectReason.WINDOW_PASSED };

    const ordered = { ...plan, parts: plan.parts.map(inTimeOrder) };
    const conflict = timelineConflict(ordered, this.timing);
    if (conflict) return { ok: false, reason: conflict };
    // Note(yoochan.kim): a flow may start late and join its music part-way, but never
    // inside its countdown's block: the count would begin in the middle, or its desk be
    // set in a hurry. Once the block is over it may start; the countdown is behind it.
    const block = countdownBlock(ordered, this.timing);
    if (block && now >= block.opens && now < block.ends) return { ok: false, reason: 'countdownUnderway' };
    this.begin(ordered);
    return { ok: true };
  }

  private begin(plan: Plan): void {
    this.active = {
      plan,
      // Note(yoochan.kim): nothing sounds before the gate engages, so the run
      // begins when the lock does, even for a timeline timed earlier.
      startsAt: plan.lock.at,
      lockEngaged: false,
      playing: undefined,
      finished: Promise.resolve(),
      restorePoint: { song: this.player.getCurrentSong(), volume: this.player.getUserVolume() },
      deckHeld: false,
      partsLeft: plan.parts.length,
      cueSounding: false,
    };
    this.active.finished = this.run(plan);
    this.publish();

    log.info('flow', null, 'Flow accepted', {
      name: plan.name,
      lock: `${formatInstant(plan.lock.at)} → ${formatInstant(plan.lock.until)}`,
      parts: plan.parts.map((part) => part.kind).join(',') || 'none',
    });
  }

  /** Ends the running flow now, and waits for its cleanup to finish. */
  async stop(): Promise<{ ok: true } | { ok: false; reason: RejectReason }> {
    const run = this.active;
    if (!run) return { ok: false, reason: RejectReason.NO_FLOW };

    log.info('flow', null, 'Flow stopped by request', { name: run.plan.name });
    // Note(yoochan.kim): a notice is cut before anything unwinds. Unwinding puts its desk back,
    // and a count still fading out as the room's sends reopen would be heard in the room.
    await this.cutCue();
    this.abortWaits();
    await run.finished;
    return { ok: true };
  }

  /** Cancels a running flow on shutdown, without waiting for cleanup. */
  dispose(): void {
    if (this.active) this.abortWaits();
  }

  // --- running ---

  private async run(plan: Plan): Promise<void> {
    try {
      await Promise.all([
        this.runLock(plan.lock),
        ...plan.parts.map((part) => (part.kind === 'music' ? this.runMusic(part, plan.lock) : this.runCountdown(part))),
      ]);
    } catch (error) {
      if (!(error instanceof FlowAborted)) {
        log.error('flow', null, 'Flow failed, cleaning up', { name: plan.name, error: errorMessage(error) });
      }
    } finally {
      await this.cleanup();
    }
  }

  private async runLock(lock: LockPlan): Promise<void> {
    await this.sleepUntil(lock.at);
    this.lockCoordinator.setAdminLock(true, 'flow');
    if (this.active) this.active.lockEngaged = true;
    this.publish();

    await this.sleepUntil(lock.until);
    // Note(yoochan.kim): Releasing is left to cleanup, so every way out of a run releases it once.
  }

  private async runMusic(part: MusicPlan, lock: LockPlan): Promise<void> {
    if (this.clock.hasPassed(part.endsAt)) {
      log.warn('flow', null, 'Music window already over, skipping playback');
      await this.partDone();
      return;
    }
    // Note(yoochan.kim): sound never precedes the gate. A timeline that begins
    // earlier is joined at the lock instant, its opening cut — the same
    // arithmetic below that lets a late start join part-way through.
    await this.sleepUntil(part.startsAt.getTime() < lock.at.getTime() ? lock.at : part.startsAt);

    // Note(yoochan.kim): Track boundaries are absolute instants off the anchor, so a late start
    // joins the timeline where it actually is and nothing accumulates drift.
    const starts = boundariesOf(part);
    const now = this.clock.now().getTime();
    const first = starts.findIndex((start, index) => now < start.getTime() + part.tracks[index]!.durationSec * 1000);
    if (first < 0) {
      await this.partDone();
      return;
    }

    for (let index = first; index < part.tracks.length; index++) {
      if (index > first) await this.sleepUntil(starts[index]!);
      if (this.clock.hasPassed(part.endsAt)) break;

      const played = await this.playTrack(part.tracks[index]!, starts[index]!, index, part.tracks.length, part.endsAt);
      if (!played) return;
    }

    await this.sleepUntil(part.endsAt);
    await this.partDone();
  }

  /**
   * Plays the countdown as one block, from `reserveMs` before its first notice to
   * the end of the count. As it opens the deck is taken and the desk set; each
   * notice goes on the deck paused as soon as the step before is done, and starts
   * by an unpause; the desk goes back once the count has ended, however it ends.
   */
  private async runCountdown(part: CountdownPlan): Promise<void> {
    const first = part.cues[0];
    if (!first) {
      await this.partDone();
      return;
    }
    const opens = new Date(first.at.getTime() - reserveMs(part, this.timing));
    await this.sleepUntil(opens);
    // Note(yoochan.kim): a flow is never started inside its countdown, so this is reached on
    // time, or after the block is over when the flow started after it. Up to the slack
    // late, there is still time to set the desk; later — a server stalled, a clock
    // that leapt — the block is skipped whole rather than joined part-way.
    const now = this.clock.now().getTime();
    if (now > opens.getTime() + this.timing.CUE_LEAD_SLACK_MS) {
      if (now >= Math.max(...part.cues.map(endOf))) log.info('flow', null, 'Countdown already over when the flow started');
      else log.warn('flow', null, 'Countdown reached after its block began; skipped whole', { notices: part.cues.length });
      await this.partDone();
      return;
    }

    // Note(yoochan.kim): each step starts the moment the one before it is confirmed, not at a
    // set time: the deck taken (a person's song fading out rather than being cut by a
    // send switching off under it), then the desk set and read back, then the first
    // notice put on the deck — each one logged with how long it took, so the lead can
    // be judged against the real desk.
    const elapsed = (): string => `${this.clock.now().getTime() - opens.getTime()}ms`;
    const taken = await this.withAudio(async () => {
      await this.player.takeDeck(!this.holdsDeck());
      this.holdDeck();
    });
    if (!taken) {
      log.error('flow', null, 'Could not take the audio device for the countdown');
      return;
    }
    log.info('flow', null, 'Countdown: deck taken', { after: elapsed() });

    const play = async (): Promise<void> => {
      if (part.desk && part.desk.length > 0) log.info('flow', null, 'Countdown: desk set', { after: elapsed() });
      try {
        for (let index = 0; index < part.cues.length; index++) {
          const cue = part.cues[index]!;
          if (this.missed(cue)) continue;
          // Put on the deck now — straight after the step before — and started on its second.
          if (!(await this.playCue(cue, { index: index + 1, total: part.cues.length }))) throw new CueFailed();
        }
      } finally {
        // Silent before the desk goes back, however this ends.
        await this.cutCue();
      }
    };
    try {
      if (part.desk && part.desk.length > 0) await this.mixer.holding(part.desk, play);
      else await play();
    } catch (error) {
      if (error instanceof FlowAborted) throw error;
      if (error instanceof CueFailed) return;
      if (error instanceof DeskRestoreError) {
        log.error('flow', null, 'The countdown has ended but the desk is not put back yet; it keeps being asked');
      } else {
        log.error('flow', null, 'The desk could not be set for the countdown, so it was not played', { error: errorMessage(error) });
      }
    }
    await this.partDone();
  }

  /**
   * Note(yoochan.kim): a clip is words true at their moment, so one whose second has gone
   * by — the desk took longer than its lead — is skipped rather than joined part-way.
   */
  private missed(cue: CuePlan): boolean {
    if (this.clock.now().getTime() <= cue.at.getTime() + this.timing.CUE_GRACE_MS) return false;
    log.warn('flow', null, 'Cue time already passed, skipping', { title: cue.track.title });
    return true;
  }

  /** Puts a cue on the deck now, starts it on its second, and waits for it to end. False when the deck could not be had. */
  private async playCue(cue: CuePlan, place: { index: number; total: number }): Promise<boolean> {
    const loaded = await this.withAudio(async () => {
      await this.player.takeDeck(!this.holdsDeck());
      this.holdDeck();
      await this.player.cueTrack(cue.track, cue.track.volume);
    });
    if (!loaded) {
      log.error('flow', null, 'Could not take the audio device for a cue', { track: cue.track.id });
      return false;
    }

    await this.sleepUntil(cue.at);
    const started = await this.withAudio(() => this.player.play());
    if (!started) {
      log.error('flow', null, 'Could not take the audio device to start a cue', { track: cue.track.id });
      return false;
    }
    const endsAt = new Date(endOf(cue));
    if (this.active) {
      this.active.playing = { track: { title: cue.track.title, ...place }, endsAt };
      this.active.cueSounding = true;
    }
    log.info('flow', null, 'Cue started', {
      cue: `${place.index}/${place.total}`,
      title: cue.track.title,
      lag: `${((this.clock.now().getTime() - cue.at.getTime()) / 1000).toFixed(2)}s`,
    });
    this.notifier.state({ playback: this.player.getState(), volume: this.player.getVolume(), flow: this.status() });

    await this.sleepUntil(endsAt);
    if (this.active) {
      this.active.playing = undefined;
      this.active.cueSounding = false;
    }
    this.publish();
    return true;
  }

  /** Silences a notice still sounding, at once: a count is cut, never faded. */
  private async cutCue(): Promise<void> {
    const run = this.active;
    if (!run?.cueSounding) return;
    const cut = await this.withAudio(() => this.player.cut());
    if (!cut) log.error('flow', null, 'Could not take the audio device to cut a notice');
    run.cueSounding = false;
  }

  /**
   * A part has played its last. The deck goes back only when no part has more to
   * play — music then cues is one stretch the run holds, not two.
   */
  private async partDone(): Promise<void> {
    const run = this.active;
    if (!run) return;
    run.playing = undefined;
    run.partsLeft -= 1;
    if (run.partsLeft === 0 && run.deckHeld) {
      // Note(yoochan.kim): the last sound reached its own end here, so there is nothing to
      // fade. A run cut short goes out through cleanup instead, which does fade.
      await this.restoreDeck(false);
      run.deckHeld = false;
    }
    this.publish();
  }

  private holdsDeck(): boolean {
    return this.active?.deckHeld ?? false;
  }

  private holdDeck(): void {
    if (this.active) this.active.deckHeld = true;
  }

  /**
   * Starts one track of the sequence. Taking the deck fades the user's song
   * out first, which takes seconds — so where this track should be is worked
   * out after that fade, not before it, or the seek would land where the music
   * was when the fade began.
   */
  private async playTrack(
    track: LibraryEntry,
    startedAt: Date,
    index: number,
    total: number,
    endsAt: Date,
  ): Promise<boolean> {
    // Note(yoochan.kim): no fade once the run has the deck. A fade between its own tracks
    // takes three seconds, and each track after the first started that much late.
    let seekSec = 0;
    const ran = await this.withAudio(async () => {
      await this.player.takeDeck(!this.holdsDeck());
      this.holdDeck();
      seekSec = Math.max(0, (this.clock.now().getTime() - startedAt.getTime()) / 1000);
      await this.player.playTrackAt(track, seekSec, track.volume, false, (track.durationSec - seekSec) * 1000);
    });
    if (!ran) {
      log.error('flow', null, 'Could not take the audio device for a track', { track: track.id });
      return false;
    }

    if (this.active) {
      this.active.playing = { track: { title: track.title, index: index + 1, total }, endsAt };
    }
    // Note(yoochan.kim): where the track was started, and how long after that point was
    // due the sound began — the plan, and what the room heard.
    const lagSec = (this.clock.now().getTime() - startedAt.getTime()) / 1000 - seekSec;
    log.info('flow', null, 'Track started', {
      track: `${index + 1}/${total}`,
      title: track.title,
      seek: `${seekSec.toFixed(1)}s`,
      lag: `${lagSec.toFixed(2)}s`,
      level: track.volume,
    });
    this.notifier.state({ playback: this.player.getState(), volume: this.player.getVolume(), flow: this.status() });
    return true;
  }

  private async cleanup(): Promise<void> {
    const run = this.active;
    if (!run) return;

    try {
      await this.restoreDeck();
    } catch (error) {
      log.error('flow', null, 'Failed to restore the deck after a flow', { error: errorMessage(error) });
    }
    if (run.lockEngaged) {
      this.lockCoordinator.setAdminLock(false);
    }

    this.active = undefined;
    this.waiters.clear();
    this.publish();
    log.info('flow', null, 'Flow finished', { name: run.plan.name });
  }

  /** Returns the deck to the two-song system; a no-op when no track took it. */
  private async restoreDeck(fade = true): Promise<void> {
    const point = this.active?.restorePoint;
    const ran = await this.withAudio(async () => {
      await this.player.restoreSong(fade);
      if (!point) return;
      // Back to the deck this run was handed, not the one it happens to find.
      if (this.player.getCurrentSong() !== point.song) await this.player.changeSong(point.song);
      this.player.setVolume(point.volume);
    });
    if (!ran) {
      log.error('flow', null, 'Could not take the audio device to restore the deck');
      return;
    }
    this.notifier.state({
      playback: this.player.getState(),
      volume: this.player.getVolume(),
      song: this.player.getCurrentSong(),
    });
  }

  private async withAudio(work: () => Promise<void>): Promise<boolean> {
    for (let attempt = 0; attempt < AUDIO_LOCK_ATTEMPTS; attempt++) {
      // Note(yoochan.kim): A flow always runs with admin standing: it is the server's own work.
      if (await this.lockCoordinator.withAudioLock(true, work)) return true;
      await delay(AUDIO_LOCK_RETRY_MS);
    }
    return false;
  }

  private publish(): void {
    this.notifier.state({ flow: this.status() });
  }

  // --- waiting ---

  private sleepUntil(target: Date): Promise<void> {
    const ms = this.clock.msUntil(target);
    if (ms <= 0) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        cancel: () => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          reject(new FlowAborted());
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve();
      }, ms);
      this.waiters.add(waiter);
    });
  }

  /**
   * Cancels every pending wait. Each rejects with FlowAborted, which unwinds
   * the parts into run()'s finally — so stopping and finishing take the same
   * cleanup path rather than two that could drift apart.
   */
  private abortWaits(): void {
    for (const waiter of [...this.waiters]) waiter.cancel();
  }

  // --- validation ---

  private planOf(args: unknown): Checked<Plan> {
    const parsed = asObject(args);
    const id = parsed.id;
    if (typeof id !== 'string' || id.length === 0) return { ok: false, reason: RejectReason.INVALID_VALUE };
    const name = parsed.name;
    if (typeof name !== 'string' || name.length === 0) return { ok: false, reason: RejectReason.INVALID_VALUE };

    const now = this.clock.now();
    const locked = this.lockOf(asObject(parsed.lock));
    if (!locked.ok) return locked;
    const lock = locked.value;

    // Note(yoochan.kim): A window that has already closed would be accepted and finish in the
    // same millisecond, which reads to the operator as the button doing
    // nothing. Refusing says what actually happened.
    if (lock.until.getTime() <= now.getTime()) return { ok: false, reason: RejectReason.WINDOW_PASSED };

    const raw = parsed.parts;
    if (!Array.isArray(raw)) return { ok: false, reason: RejectReason.INVALID_VALUE };

    const parts: PartPlan[] = [];
    const seen = new Set<string>();

    for (const entry of raw) {
      const part = asObject(entry);
      const kind = part.kind;
      if (typeof kind !== 'string' || seen.has(kind)) return { ok: false, reason: RejectReason.INVALID_VALUE };
      seen.add(kind);

      if (kind !== 'music') return { ok: false, reason: RejectReason.INVALID_VALUE };
      const planned = this.musicPartOf(part, lock);
      if (!planned.ok) return planned;
      parts.push(planned.value);
    }

    return { ok: true, value: { id, name, lock, parts } };
  }

  private lockOf(lock: Record<string, unknown>): Checked<LockPlan> {
    const at = instantOf(lock.at);
    if (!at.ok) return at;
    const until = instantOf(lock.until);
    if (!until.ok) return until;

    // Note(yoochan.kim): A window has to have room in it. Crossing midnight needs no special case
    // now that both ends carry their own date.
    if (until.value.getTime() <= at.value.getTime()) {
      return { ok: false, reason: RejectReason.INVALID_VALUE };
    }
    return { ok: true, value: { at: at.value, until: until.value } };
  }

  private musicPartOf(part: Record<string, unknown>, lock: LockPlan): Checked<PartPlan> {
    const cues = part.tracks;
    if (!Array.isArray(cues) || cues.length === 0) return { ok: false, reason: RejectReason.INVALID_VALUE };

    // Note(yoochan.kim): every cue carries its own level. The caller decided how
    // loud this flow sounds when they wrote it, rather than inheriting whatever
    // the panel happened to be left at.
    const tracks: ScheduledEntry[] = [];
    for (const cue of cues) {
      const { id, volume } = (cue ?? {}) as Record<string, unknown>;
      if (typeof id !== 'string') return { ok: false, reason: RejectReason.INVALID_VALUE };
      if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 0 || volume > 100) {
        return { ok: false, reason: RejectReason.INVALID_VALUE };
      }
      const track = this.trackLibrary.get(id);
      if (!track) return { ok: false, reason: RejectReason.UNKNOWN_TRACK };
      tracks.push({ ...track, volume });
    }

    const finish = instantOf(part.endsAt);
    if (!finish.ok) return finish;

    // Note(yoochan.kim): The anchor is the finish, so the start is derived: this is what lets a
    // late start join part-way through instead of running long.
    const endsAt = finish.value;
    const totalMs = tracks.reduce((sum, track) => sum + track.durationSec, 0) * 1000;
    const startsAt = new Date(endsAt.getTime() - totalMs);

    // Note(yoochan.kim): only the finish is bound to the window. Running past
    // the unlock would sound on an open panel, and ending before the gate
    // engages could never sound — both refused, because the caller wrote those
    // times on purpose. A start before the window is fine: the sound begins
    // with the lock, its opening cut.
    if (endsAt.getTime() > lock.until.getTime() || endsAt.getTime() <= lock.at.getTime()) {
      return { ok: false, reason: RejectReason.MUSIC_OUTSIDE_LOCK };
    }

    return { ok: true, value: { kind: 'music', tracks, startsAt, endsAt } };
  }
}

/** Why a timeline cannot be played as written. Internal until the protocol carries the countdown. */
export type TimelineConflict = 'countdownOutsideLock' | 'cuesOverlap' | 'countdownOverlapsMusic';

const endOf = (cue: CuePlan): number => cue.at.getTime() + cue.track.durationSec * 1000;

const tracksOf = (part: PartPlan): ScheduledEntry[] =>
  (part.kind === 'music' ? part.tracks : part.cues.map((cue) => cue.track));

function inTimeOrder(part: PartPlan): PartPlan {
  return part.kind === 'countdown' ? { ...part, cues: [...part.cues].sort((a, b) => a.at.getTime() - b.at.getTime()) } : part;
}

/**
 * How long before its first notice a countdown's block begins: room to fade out
 * what is playing and to absorb a late arrival, time to set the desk, and time to
 * put the notice on the deck. Nothing else may sound in it.
 */
export function reserveMs(part: CountdownPlan, timing: FlowTiming): number {
  const desk = part.desk && part.desk.length > 0 ? timing.CUE_DESK_LEAD_MS : 0;
  return timing.CUE_LEAD_SLACK_MS + desk + timing.CUE_PRELOAD_MS;
}

/** When a plan's countdown block begins and ends, or null for a plan without one. */
export function countdownBlock(plan: Pick<Plan, 'parts'>, timing: FlowTiming): { opens: number; ends: number } | null {
  const part = plan.parts.find((candidate): candidate is CountdownPlan => candidate.kind === 'countdown');
  if (!part || part.cues.length === 0) return null;
  const cues = (inTimeOrder(part) as CountdownPlan).cues;
  return { opens: cues[0]!.at.getTime() - reserveMs(part, timing), ends: Math.max(...cues.map(endOf)) };
}

/**
 * Whether the countdown can be heard on its own. Its block — from `reserveMs`
 * before its first notice to the end of the count — lies inside the gate's
 * window and in no stretch the run's music is playing, and no notice begins
 * before the one ahead of it has ended. That is how a flow keeps other music off
 * it. Music is counted from when it can first sound, the lock.
 */
export function timelineConflict(plan: Pick<Plan, 'lock' | 'parts'>, timing: FlowTiming): TimelineConflict | null {
  const lockAt = plan.lock.at.getTime();
  const music = plan.parts.flatMap((part) => (part.kind === 'music'
    ? [{ from: Math.max(part.startsAt.getTime(), lockAt), to: part.endsAt.getTime() }]
    : []));

  for (const part of plan.parts) {
    if (part.kind !== 'countdown' || part.cues.length === 0) continue;
    const cues = (inTimeOrder(part) as CountdownPlan).cues;
    let previousEnd = -Infinity;
    for (const cue of cues) {
      if (cue.at.getTime() < previousEnd) return 'cuesOverlap';
      previousEnd = endOf(cue);
    }
    const from = cues[0]!.at.getTime() - reserveMs(part, timing);
    if (from < lockAt || previousEnd > plan.lock.until.getTime()) return 'countdownOutsideLock';
    if (music.some((span) => from < span.to && previousEnd > span.from)) return 'countdownOverlapsMusic';
  }
  return null;
}

/** Absolute instant each track of a music part begins */
function boundariesOf(part: MusicPlan): Date[] {
  const starts: Date[] = [];
  let offsetMs = 0;
  for (const track of part.tracks) {
    starts.push(new Date(part.startsAt.getTime() + offsetMs));
    offsetMs += track.durationSec * 1000;
  }
  return starts;
}

export default FlowRunner;
