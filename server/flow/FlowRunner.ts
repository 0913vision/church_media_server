import { RejectReason } from '../protocol.ts';
import type { FlowStatus, FlowTrack } from '../protocol.ts';
import type Player from '../player/Player.ts';
import type TrackLibrary from '../tracks/TrackLibrary.ts';
import type { LibraryEntry } from '../tracks/TrackLibrary.ts';
import type LockCoordinator from '../lock/LockCoordinator.ts';
import type Notifier from '../notify/Notifier.ts';
import type Clock from '../clock/Clock.ts';
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

/** A part of a validated plan, mirroring the protocol's FlowPart */
/** A library track as one flow scheduled it: same audio, that flow's level */
type ScheduledEntry = LibraryEntry;

type PartPlan = { kind: 'music'; tracks: ScheduledEntry[]; startsAt: Date; endsAt: Date };

/** The window this run holds the admin gate for. Every run has one. */
interface LockPlan {
  at: Date;
  until: Date;
}

interface Plan {
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
  ) {}

  /**
   * What the flow slot is doing. Derived from the run rather than stored, so
   * it cannot drift from what is actually happening.
   */
  status(): FlowStatus {
    const run = this.active;
    if (!run) return { phase: 'idle' };

    if (run.playing) {
      return { phase: 'playing', name: run.plan.name, track: run.playing.track, endsAt: formatInstant(run.playing.endsAt) };
    }
    if (run.lockEngaged) {
      return { phase: 'holding', name: run.plan.name, unlockAt: formatInstant(run.plan.lock.until) };
    }
    return { phase: 'waiting', name: run.plan.name, startsAt: formatInstant(run.startsAt) };
  }

  /** Whether a running flow is the one holding the admin lock */
  ownsAdminLock(): boolean {
    return this.active?.lockEngaged ?? false;
  }

  /** Accepts a flow and starts running it. */
  async start(args: unknown): Promise<{ ok: true } | { ok: false; reason: RejectReason }> {
    if (this.active) return { ok: false, reason: RejectReason.FLOW_ACTIVE };

    const planned = this.planOf(args);
    if (!planned.ok) return planned;

    const plan = planned.value;
    this.active = {
      plan,
      // Note(yoochan.kim): nothing sounds before the gate engages, so the run
      // begins when the lock does, even for a timeline timed earlier.
      startsAt: plan.lock.at,
      lockEngaged: false,
      playing: undefined,
      finished: Promise.resolve(),
    };
    this.active.finished = this.run(plan);
    this.publish();

    log.info('flow', null, 'Flow accepted', {
      name: plan.name,
      lock: `${formatInstant(plan.lock.at)} → ${formatInstant(plan.lock.until)}`,
      parts: plan.parts.map((part) => part.kind).join(',') || 'none',
    });
    return { ok: true };
  }

  /** Ends the running flow now, and waits for its cleanup to finish. */
  async stop(): Promise<{ ok: true } | { ok: false; reason: RejectReason }> {
    const run = this.active;
    if (!run) return { ok: false, reason: RejectReason.NO_FLOW };

    log.info('flow', null, 'Flow stopped by request', { name: run.plan.name });
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
      await Promise.all([this.runLock(plan.lock), ...plan.parts.map((part) => this.runMusic(part, plan.lock))]);
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
    this.lockCoordinator.setAdminLock(true);
    if (this.active) this.active.lockEngaged = true;
    this.publish();

    await this.sleepUntil(lock.until);
    // Note(yoochan.kim): Releasing is left to cleanup, so every way out of a run releases it once.
  }

  private async runMusic(part: Extract<PartPlan, { kind: 'music' }>, lock: LockPlan): Promise<void> {
    if (this.clock.hasPassed(part.endsAt)) {
      log.warn('flow', null, 'Music window already over, skipping playback');
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
    if (first < 0) return;

    for (let index = first; index < part.tracks.length; index++) {
      if (index > first) await this.sleepUntil(starts[index]!);
      if (this.clock.hasPassed(part.endsAt)) break;

      const played = await this.playTrack(part.tracks[index]!, starts[index]!, index, part.tracks.length, part.endsAt);
      if (!played) return;
    }

    await this.sleepUntil(part.endsAt);
    await this.restoreDeck();
    if (this.active) this.active.playing = undefined;
    this.publish();
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
    const ran = await this.withAudio(async () => {
      await this.player.takeDeck();
      const offsetSec = Math.max(0, (this.clock.now().getTime() - startedAt.getTime()) / 1000);
      await this.player.playTrackAt(track.file, offsetSec, track.volume);
    });
    if (!ran) {
      log.error('flow', null, 'Could not take the audio device for a track', { track: track.id });
      return false;
    }

    if (this.active) {
      this.active.playing = { track: { title: track.title, index: index + 1, total }, endsAt };
    }
    log.info('flow', null, 'Track started', {
      track: `${index + 1}/${total}`,
      title: track.title,
      offset: `${offsetOf(this.clock, startedAt)}s`,
    });
    this.notifier.state({ playback: this.player.getState(), flow: this.status() });
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
  private async restoreDeck(): Promise<void> {
    const ran = await this.withAudio(() => this.player.restoreSong());
    if (!ran) {
      log.error('flow', null, 'Could not take the audio device to restore the deck');
      return;
    }
    this.notifier.state({ playback: this.player.getState(), song: this.player.getCurrentSong() });
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

    return { ok: true, value: { name, lock, parts } };
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

/** How far into a track the deck actually landed, for the log */
function offsetOf(clock: Clock, startedAt: Date): string {
  return (Math.max(0, (clock.now().getTime() - startedAt.getTime()) / 1000)).toFixed(1);
}

/** Absolute instant each track of a music part begins */
function boundariesOf(part: Extract<PartPlan, { kind: 'music' }>): Date[] {
  const starts: Date[] = [];
  let offsetMs = 0;
  for (const track of part.tracks) {
    starts.push(new Date(part.startsAt.getTime() + offsetMs));
    offsetMs += track.durationSec * 1000;
  }
  return starts;
}

export default FlowRunner;
