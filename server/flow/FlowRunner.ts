import { RejectReason, TrackRole, isNotice } from '../protocol.ts';
import type { FlowStatus, FlowTrack, Notice } from '../protocol.ts';
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

type Checked<T> = { ok: true; value: T } | { ok: false; reason: RejectReason };


// Note(yoochan.kim): an admin's write holds the audio lock up to one fade; retry across it rather than drop a track.
const AUDIO_LOCK_ATTEMPTS = 12;
const AUDIO_LOCK_RETRY_MS = 300;

/** A library track as one flow scheduled it: same audio, that flow's level */
type ScheduledEntry = LibraryEntry;

/** How long before zero each notice starts. */
const NOTICE_LEAD_SEC: Record<Notice, number> = { oneMinute: 60, thirtySeconds: 30 };

/** One clip of a countdown, played on its own second. */
export interface CuePlan {
  track: ScheduledEntry;
  at: Date;
}

/** The count and the notices ticked ahead of it, one block in which nothing else sounds. */
export interface CountdownPlan {
  kind: 'countdown';
  cues: CuePlan[];
  /** Held for the whole block, in the order to set it; a countdown whose desk cannot be set is not played. */
  desk?: readonly DeskChange[];
}

/** A clip that could not take the audio device: the countdown gives up, as music does. */
class CueFailed extends Error {}

type MusicPlan = { kind: 'music'; tracks: ScheduledEntry[]; startsAt: Date; endsAt: Date };
/** A part of a validated plan: the protocol's FlowPart. */
export type PartPlan = MusicPlan | CountdownPlan;

/** Every run holds the gate for this window, or its music on an open panel could be taken over from the tablet. */
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
  /** Note(yoochan.kim): taken at acceptance, not at the end: what someone does on the panel mid-run is theirs. */
  restorePoint: { song: SongId; volume: number };
  /** From the run's first sound until its last has ended, gaps included, so nothing else plays in between. */
  deckHeld: boolean;
  /** Parts still to finish sounding; the one that brings this to none puts the deck back. */
  partsLeft: number;
  /** A countdown notice is sounding. A stop cuts it at once, before its desk goes back. */
  cueSounding: boolean;
}

/** Only ISO 8601 with a date: which day a bare time means is the caller's to decide, not the runner's. */
function instantOf(value: unknown): Checked<Date> {
  // Note(yoochan.kim): one spelling only; every form Date accepts is one some client could come to depend on.
  if (!isWireInstant(value)) return { ok: false, reason: RejectReason.INVALID_VALUE };
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return { ok: false, reason: RejectReason.INVALID_VALUE };
  return { ok: true, value: at };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs one flow at a time from acceptance to cleanup; it knows only the run, never the calendar it came from. */
class FlowRunner {
  private active: ActiveRun | undefined;
  private readonly waiters = new Set<Waiter>();

  constructor(
    private readonly player: Player,
    private readonly trackLibrary: TrackLibrary,
    private readonly lockCoordinator: LockCoordinator,
    private readonly notifier: Notifier,
    // Note(yoochan.kim): every instant in a plan is church time, so the runner never reads the system clock.
    private readonly clock: Clock,
    private readonly mixer: Pick<MixerConsole, 'holding'>,
    /** The desk while a countdown runs, in the order to set it. */
    private readonly countdownDesk: readonly DeskChange[],
    private readonly timing: FlowTiming,
  ) {}

  /** Derived from the run rather than stored, so it cannot drift from what is actually happening. */
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

  ownsAdminLock(): boolean {
    return this.active?.lockEngaged ?? false;
  }

  /** Note(yoochan.kim): from the run's first sound to its last; holding only the gate leaves the deck free. */
  ownsDeck(): boolean {
    return this.active?.deckHeld ?? false;
  }

  /** Note(yoochan.kim): a run copied its tracks at acceptance, so an edited calendar cannot say what it will play. */
  uses(trackId: string): boolean {
    return this.active?.plan.parts.some((part) => tracksOf(part).some((track) => track.id === trackId)) ?? false;
  }

  async start(args: unknown): Promise<{ ok: true } | { ok: false; reason: RejectReason }> {
    if (this.active) return { ok: false, reason: RejectReason.FLOW_ACTIVE };

    const planned = this.planOf(args);
    if (!planned.ok) return planned;
    return this.startPlan(planned.value);
  }

  /** Whether a run could be played as written, without starting it: for a calendar entry being saved. */
  check(args: unknown): { ok: true } | { ok: false; reason: RejectReason } {
    const planned = this.planOf(args);
    if (!planned.ok) return planned;
    const conflict = timelineConflict({ ...planned.value, parts: planned.value.parts.map(inTimeOrder) }, this.timing);
    return conflict ? { ok: false, reason: conflict } : { ok: true };
  }

  startPlan(plan: Plan): { ok: true } | { ok: false; reason: RejectReason } {
    if (this.active) return { ok: false, reason: RejectReason.FLOW_ACTIVE };
    const now = this.clock.now().getTime();
    if (plan.lock.until.getTime() <= now) return { ok: false, reason: RejectReason.WINDOW_PASSED };

    const ordered = { ...plan, parts: plan.parts.map(inTimeOrder) };
    const conflict = timelineConflict(ordered, this.timing);
    if (conflict) return { ok: false, reason: conflict };
    // Note(yoochan.kim): never inside its countdown's block: the count would start mid-way, its desk set in a hurry.
    const block = countdownBlock(ordered, this.timing);
    if (block && now >= block.opens && now < block.ends) return { ok: false, reason: RejectReason.COUNTDOWN_UNDERWAY };
    this.begin(ordered);
    return { ok: true };
  }

  private begin(plan: Plan): void {
    this.active = {
      plan,
      // Note(yoochan.kim): nothing sounds before the gate engages, so the run begins with the lock however timed.
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

  async stop(): Promise<{ ok: true } | { ok: false; reason: RejectReason }> {
    const run = this.active;
    if (!run) return { ok: false, reason: RejectReason.NO_FLOW };

    log.info('flow', null, 'Flow stopped by request', { name: run.plan.name });
    // Note(yoochan.kim): cut before unwinding puts the desk back, or a count still fading would be heard in the room.
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
      // Note(yoochan.kim): the gate and each part keep to the wall clock on their own; the run ends when all are done.
      await Promise.all([
        this.runLock(plan.lock),
        ...plan.parts.map((part) => (part.kind === 'music' ? this.runMusic(part, plan.lock) : this.runCountdown(part))),
      ]);
    } catch (error) {
      if (!(error instanceof FlowAborted)) {
        log.error('flow', null, 'Flow failed, cleaning up', { name: plan.name, error: errorMessage(error) });
      }
    } finally {
      // Note(yoochan.kim): every way out ends here, so a lock can never outlive the client that asked for it.
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
    // Note(yoochan.kim): sound never precedes the gate; an earlier timeline is joined at the lock, like a late start.
    await this.sleepUntil(part.startsAt.getTime() < lock.at.getTime() ? lock.at : part.startsAt);

    // Note(yoochan.kim): absolute boundaries, so a late start joins where the timeline is and nothing drifts.
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

  /** Plays the countdown as one block, each notice loaded paused ahead and started by an unpause on its second. */
  private async runCountdown(part: CountdownPlan): Promise<void> {
    const first = part.cues[0];
    if (!first) {
      await this.partDone();
      return;
    }
    const opens = new Date(first.at.getTime() - reserveMs(part, this.timing));
    await this.sleepUntil(opens);
    // Note(yoochan.kim): within the slack the desk can still be set; later the block is skipped, never joined part-way.
    const now = this.clock.now().getTime();
    if (now > opens.getTime() + this.timing.CUE_LEAD_SLACK_MS) {
      if (now >= Math.max(...part.cues.map(endOf))) log.info('flow', null, 'Countdown already over when the flow started');
      else log.warn('flow', null, 'Countdown reached after its block began; skipped whole', { notices: part.cues.length });
      await this.partDone();
      return;
    }

    // Note(yoochan.kim): each step is logged with its time, so the lead can be judged against the real desk.
    const elapsed = (): string => `${this.clock.now().getTime() - opens.getTime()}ms`;
    // Note(yoochan.kim): deck before desk, so a person's song fades out rather than being cut by a send switching off.
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
          // Note(yoochan.kim): put on the deck straight after the step before, and started on its second.
          if (!(await this.playCue(cue, { index: index + 1, total: part.cues.length }))) throw new CueFailed();
        }
      } finally {
        // Note(yoochan.kim): silent before the desk goes back, however this ends, or the room hears the count.
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

  /** Note(yoochan.kim): a clip's words are true only at their second, so a late one is skipped, not joined part-way. */
  private missed(cue: CuePlan): boolean {
    if (this.clock.now().getTime() <= cue.at.getTime() + this.timing.CUE_GRACE_MS) return false;
    log.warn('flow', null, 'Cue time already passed, skipping', { title: cue.track.title });
    return true;
  }

  /** Loads a cue now, starts it on its second and waits for its end; false when the deck could not be had. */
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

  /** The deck goes back only after the last part: music then countdown is one stretch the run holds, not two. */
  private async partDone(): Promise<void> {
    const run = this.active;
    if (!run) return;
    run.playing = undefined;
    run.partsLeft -= 1;
    if (run.partsLeft === 0 && run.deckHeld) {
      // Note(yoochan.kim): the last sound ended by itself, so no fade; a run cut short fades out through cleanup.
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

  private async playTrack(
    track: LibraryEntry,
    startedAt: Date,
    index: number,
    total: number,
    endsAt: Date,
  ): Promise<boolean> {
    // Note(yoochan.kim): no fade once the run holds the deck; a fade between its own tracks would start each 3s late.
    let seekSec = 0;
    const ran = await this.withAudio(async () => {
      await this.player.takeDeck(!this.holdsDeck());
      this.holdDeck();
      // Note(yoochan.kim): after takeDeck's fade, which takes seconds, or the seek lands where the music was before it.
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
    // Note(yoochan.kim): seek is the plan, lag how long after that point was due the room heard it begin.
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

  /** Returns the deck to the user's song; a no-op when no track took it. */
  private async restoreDeck(fade = true): Promise<void> {
    const point = this.active?.restorePoint;
    const ran = await this.withAudio(async () => {
      await this.player.restoreSong(fade);
      if (!point) return;
      // Note(yoochan.kim): back to the deck this run was handed, not the one it happens to find.
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

  /** Each wait rejects with FlowAborted into run()'s finally, so stopping and finishing share one cleanup path. */
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

    const locked = this.lockOf(asObject(parsed.lock));
    if (!locked.ok) return locked;
    const lock = locked.value;

    const raw = parsed.parts;
    if (!Array.isArray(raw)) return { ok: false, reason: RejectReason.INVALID_VALUE };

    const parts: PartPlan[] = [];
    const seen = new Set<string>();

    for (const entry of raw) {
      const part = asObject(entry);
      const kind = part.kind;
      if (typeof kind !== 'string' || seen.has(kind)) return { ok: false, reason: RejectReason.INVALID_VALUE };
      seen.add(kind);

      if (kind !== 'music' && kind !== 'countdown') return { ok: false, reason: RejectReason.INVALID_VALUE };
      const planned = kind === 'music' ? this.musicPartOf(part, lock) : this.countdownPartOf(part);
      if (!planned.ok) return planned;
      parts.push(planned.value);
    }

    return { ok: true, value: { id, name, lock, parts } };
  }

  /** A countdown: the count ending at zero, and each notice asked for at its own lead. */
  private countdownPartOf(part: Record<string, unknown>): Checked<PartPlan> {
    const zero = instantOf(part.at);
    if (!zero.ok) return zero;
    const notices = part.notices;
    if (!Array.isArray(notices) || !notices.every(isNotice) || new Set(notices).size !== notices.length) {
      return { ok: false, reason: RejectReason.INVALID_VALUE };
    }

    const count = this.trackLibrary.countdownTrack(TrackRole.COUNT);
    if (!count) return { ok: false, reason: RejectReason.NOTICE_MISSING };
    const cues: CuePlan[] = [];
    for (const notice of notices) {
      const track = this.trackLibrary.countdownTrack(notice);
      if (!track) return { ok: false, reason: RejectReason.NOTICE_MISSING };
      cues.push({ track: { ...track }, at: new Date(zero.value.getTime() - NOTICE_LEAD_SEC[notice] * 1000) });
    }
    cues.push({ track: { ...count }, at: new Date(zero.value.getTime() - count.durationSec * 1000) });
    return { ok: true, value: { kind: 'countdown', cues, desk: this.countdownDesk } };
  }

  private lockOf(lock: Record<string, unknown>): Checked<LockPlan> {
    const at = instantOf(lock.at);
    if (!at.ok) return at;
    const until = instantOf(lock.until);
    if (!until.ok) return until;

    // Note(yoochan.kim): a window needs room in it; one crossing midnight needs no special case, both ends have a date.
    if (until.value.getTime() <= at.value.getTime()) {
      return { ok: false, reason: RejectReason.INVALID_VALUE };
    }
    return { ok: true, value: { at: at.value, until: until.value } };
  }

  private musicPartOf(part: Record<string, unknown>, lock: LockPlan): Checked<PartPlan> {
    const cues = part.tracks;
    if (!Array.isArray(cues) || cues.length === 0) return { ok: false, reason: RejectReason.INVALID_VALUE };

    // Note(yoochan.kim): each cue carries its own level, so the flow sounds as written, not as the panel was left.
    const tracks: ScheduledEntry[] = [];
    for (const cue of cues) {
      const { id, volume } = (cue ?? {}) as Record<string, unknown>;
      if (typeof id !== 'string') return { ok: false, reason: RejectReason.INVALID_VALUE };
      if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 0 || volume > 100) {
        return { ok: false, reason: RejectReason.INVALID_VALUE };
      }
      const track = this.trackLibrary.get(id);
      if (!track) return { ok: false, reason: RejectReason.UNKNOWN_TRACK };
      if (this.trackLibrary.isCountdownTrack(id)) return { ok: false, reason: RejectReason.NOTICE_TRACK };
      tracks.push({ ...track, volume });
    }

    const finish = instantOf(part.endsAt);
    if (!finish.ok) return finish;

    // Note(yoochan.kim): the finish anchors the start, so a late start joins part-way instead of running long.
    const endsAt = finish.value;
    const totalMs = tracks.reduce((sum, track) => sum + track.durationSec, 0) * 1000;
    const startsAt = new Date(endsAt.getTime() - totalMs);

    // Note(yoochan.kim): only the finish is bound: past the unlock it sounds on an open panel, before the gate never.
    if (endsAt.getTime() > lock.until.getTime() || endsAt.getTime() <= lock.at.getTime()) {
      return { ok: false, reason: RejectReason.MUSIC_OUTSIDE_LOCK };
    }

    return { ok: true, value: { kind: 'music', tracks, startsAt, endsAt } };
  }
}

/** Why a timeline cannot be played as written. */
export type TimelineConflict =
  | typeof RejectReason.COUNTDOWN_OUTSIDE_LOCK
  | typeof RejectReason.NOTICES_OVERLAP
  | typeof RejectReason.COUNTDOWN_OVERLAPS_MUSIC;

const endOf = (cue: CuePlan): number => cue.at.getTime() + cue.track.durationSec * 1000;

const tracksOf = (part: PartPlan): ScheduledEntry[] =>
  (part.kind === 'music' ? part.tracks : part.cues.map((cue) => cue.track));

function inTimeOrder(part: PartPlan): PartPlan {
  return part.kind === 'countdown' ? { ...part, cues: [...part.cues].sort((a, b) => a.at.getTime() - b.at.getTime()) } : part;
}

/** How long before its first notice a countdown's block opens; the slack is for a fade out and a late arrival. */
export function reserveMs(part: CountdownPlan, timing: FlowTiming): number {
  const desk = part.desk && part.desk.length > 0 ? timing.CUE_DESK_LEAD_MS : 0;
  return timing.CUE_LEAD_SLACK_MS + desk + timing.CUE_PRELOAD_MS;
}

export function countdownBlock(plan: Pick<Plan, 'parts'>, timing: FlowTiming): { opens: number; ends: number } | null {
  const part = plan.parts.find((candidate): candidate is CountdownPlan => candidate.kind === 'countdown');
  if (!part || part.cues.length === 0) return null;
  const cues = (inTimeOrder(part) as CountdownPlan).cues;
  return { opens: cues[0]!.at.getTime() - reserveMs(part, timing), ends: Math.max(...cues.map(endOf)) };
}

/** Whether the countdown is heard on its own; music timed before the gate counts from the lock, its first sound. */
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
      if (cue.at.getTime() < previousEnd) return RejectReason.NOTICES_OVERLAP;
      previousEnd = endOf(cue);
    }
    const from = cues[0]!.at.getTime() - reserveMs(part, timing);
    if (from < lockAt || previousEnd > plan.lock.until.getTime()) return RejectReason.COUNTDOWN_OUTSIDE_LOCK;
    if (music.some((span) => from < span.to && previousEnd > span.from)) return RejectReason.COUNTDOWN_OVERLAPS_MUSIC;
  }
  return null;
}

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
