import { RejectReason } from '../protocol.ts';
import type { FlowStatus, FlowTrack } from '../protocol.ts';
import type Player from '../player/Player.ts';
import type TrackLibrary from '../tracks/TrackLibrary.ts';
import type { LibraryEntry } from '../tracks/TrackLibrary.ts';
import type LockCoordinator from '../lock/LockCoordinator.ts';
import type Notifier from '../notify/Notifier.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

/** Result of checking part of a request */
type Checked<T> = { ok: true; value: T } | { ok: false; reason: RejectReason };

const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A flow's own audio work can collide with an admin writing at the same
// moment. Contention lasts at most one fade, so retry across that window
// rather than dropping a track.
const AUDIO_LOCK_ATTEMPTS = 12;
const AUDIO_LOCK_RETRY_MS = 300;

/** A part of a validated plan, mirroring the protocol's FlowPart */
type PartPlan =
  | { kind: 'music'; tracks: LibraryEntry[]; startsAt: Date; endsAt: Date }
  | { kind: 'lock'; at: Date; until: Date };

interface Plan {
  name: string;
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

function clockOf(value: unknown): Checked<{ hours: number; minutes: number }> {
  if (typeof value !== 'string') return { ok: false, reason: RejectReason.INVALID_VALUE };
  const match = CLOCK_PATTERN.exec(value);
  if (!match) return { ok: false, reason: RejectReason.INVALID_VALUE };
  return { ok: true, value: { hours: Number(match[1]), minutes: Number(match[2]) } };
}

function todayAt(now: Date, clock: { hours: number; minutes: number }): Date {
  const at = new Date(now);
  at.setHours(clock.hours, clock.minutes, 0, 0);
  return at;
}

/** Today's occurrence, rolled to tomorrow when it would not be after `anchor` */
function firstAfter(anchor: Date, now: Date, clock: { hours: number; minutes: number }): Date {
  const at = todayAt(now, clock);
  return at.getTime() > anchor.getTime() ? at : new Date(at.getTime() + MS_PER_DAY);
}

function formatClock(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
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
 * A flow's parts are independent — the lock window and the music timeline each
 * keep to the wall clock on their own, and the run ends when both are done.
 * Whatever ends it, cleanup restores the user's song and releases the lock, so
 * a lock can never outlive the client that asked for it.
 */
class FlowRunner {
  private active: ActiveRun | undefined;
  private readonly waiters = new Set<Waiter>();

  constructor(
    private readonly player: Player,
    private readonly trackLibrary: TrackLibrary,
    private readonly lockCoordinator: LockCoordinator,
    private readonly notifier: Notifier,
  ) {}

  /**
   * What the flow slot is doing. Derived from the run rather than stored, so
   * it cannot drift from what is actually happening.
   */
  status(): FlowStatus {
    const run = this.active;
    if (!run) return { phase: 'idle' };

    if (run.playing) {
      return { phase: 'playing', name: run.plan.name, track: run.playing.track, endsAt: formatClock(run.playing.endsAt) };
    }
    if (run.lockEngaged) {
      const lock = run.plan.parts.find((part) => part.kind === 'lock');
      if (lock) return { phase: 'holding', name: run.plan.name, unlockAt: formatClock(lock.until) };
    }
    return { phase: 'waiting', name: run.plan.name, startsAt: formatClock(run.startsAt) };
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
      startsAt: plan.parts.reduce(
        (earliest, part) => {
          const at = part.kind === 'lock' ? part.at : part.startsAt;
          return at.getTime() < earliest.getTime() ? at : earliest;
        },
        part0Start(plan),
      ),
      lockEngaged: false,
      playing: undefined,
      finished: Promise.resolve(),
    };
    this.active.finished = this.run(plan);
    this.publish();

    log.info('flow', null, 'Flow accepted', { name: plan.name, parts: plan.parts.map((part) => part.kind) });
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
      await Promise.all(
        plan.parts.map((part) => (part.kind === 'lock' ? this.runLock(part) : this.runMusic(part))),
      );
    } catch (error) {
      if (!(error instanceof FlowAborted)) {
        log.error('flow', null, 'Flow failed, cleaning up', { name: plan.name, error: errorMessage(error) });
      }
    } finally {
      await this.cleanup();
    }
  }

  private async runLock(part: Extract<PartPlan, { kind: 'lock' }>): Promise<void> {
    await this.sleepUntil(part.at);
    this.lockCoordinator.setAdminLock(true);
    if (this.active) this.active.lockEngaged = true;
    this.publish();

    await this.sleepUntil(part.until);
    // Releasing is left to cleanup, so every way out of a run releases it once.
  }

  private async runMusic(part: Extract<PartPlan, { kind: 'music' }>): Promise<void> {
    if (Date.now() >= part.endsAt.getTime()) {
      log.warn('flow', null, 'Music window already over, skipping playback');
      return;
    }
    await this.sleepUntil(part.startsAt);

    // Track boundaries are absolute instants off the anchor, so a late start
    // joins the timeline where it actually is and nothing accumulates drift.
    const starts = boundariesOf(part);
    const now = Date.now();
    const first = starts.findIndex((start, index) => now < start.getTime() + part.tracks[index]!.durationSec * 1000);
    if (first < 0) return;

    for (let index = first; index < part.tracks.length; index++) {
      if (index > first) await this.sleepUntil(starts[index]!);
      if (Date.now() >= part.endsAt.getTime()) break;

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
      const offsetSec = Math.max(0, (Date.now() - startedAt.getTime()) / 1000);
      await this.player.playTrackAt(track.file, offsetSec);
    });
    if (!ran) {
      log.error('flow', null, 'Could not take the audio device for a track', { track: track.id });
      return false;
    }

    if (this.active) {
      this.active.playing = { track: { title: track.title, index: index + 1, total }, endsAt };
    }
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
      // A flow always runs with admin standing: it is the server's own work.
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
    const ms = target.getTime() - Date.now();
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

    const raw = parsed.parts;
    if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: RejectReason.INVALID_VALUE };

    const now = new Date();
    const parts: PartPlan[] = [];
    const seen = new Set<string>();

    for (const entry of raw) {
      const part = asObject(entry);
      const kind = part.kind;
      if (typeof kind !== 'string' || seen.has(kind)) return { ok: false, reason: RejectReason.INVALID_VALUE };
      seen.add(kind);

      if (kind === 'lock') {
        const planned = this.lockPartOf(part, now);
        if (!planned.ok) return planned;
        parts.push(planned.value);
        continue;
      }
      if (kind === 'music') {
        const planned = this.musicPartOf(part, now);
        if (!planned.ok) return planned;
        parts.push(planned.value);
        continue;
      }
      return { ok: false, reason: RejectReason.INVALID_VALUE };
    }

    // A flow whose every part is already over would be accepted and finish in
    // the same millisecond, which reads to the operator as the button doing
    // nothing. Refusing says what actually happened.
    if (parts.every((part) => endOf(part).getTime() <= now.getTime())) {
      return { ok: false, reason: RejectReason.WINDOW_PASSED };
    }

    return { ok: true, value: { name, parts } };
  }

  private lockPartOf(part: Record<string, unknown>, now: Date): Checked<PartPlan> {
    const at = clockOf(part.at);
    if (!at.ok) return at;
    const until = clockOf(part.until);
    if (!until.ok) return until;

    // "Already past means immediately", and the window always closes after it
    // opens — a release before midnight-crossing is the next day's.
    const opensAt = todayAt(now, at.value);
    const closesAt = firstAfter(opensAt, now, until.value);
    return { ok: true, value: { kind: 'lock', at: opensAt, until: closesAt } };
  }

  private musicPartOf(part: Record<string, unknown>, now: Date): Checked<PartPlan> {
    const ids = part.tracks;
    if (!Array.isArray(ids) || ids.length === 0) return { ok: false, reason: RejectReason.INVALID_VALUE };

    const tracks: LibraryEntry[] = [];
    for (const id of ids) {
      if (typeof id !== 'string') return { ok: false, reason: RejectReason.INVALID_VALUE };
      const track = this.trackLibrary.get(id);
      if (!track) return { ok: false, reason: RejectReason.UNKNOWN_TRACK };
      tracks.push(track);
    }

    const endsAtClock = clockOf(part.endsAt);
    if (!endsAtClock.ok) return endsAtClock;

    // The anchor is the finish, so the start is derived: this is what lets a
    // late start join part-way through instead of running long.
    const endsAt = todayAt(now, endsAtClock.value);
    const totalMs = tracks.reduce((sum, track) => sum + track.durationSec, 0) * 1000;
    const startsAt = new Date(endsAt.getTime() - totalMs);
    return { ok: true, value: { kind: 'music', tracks, startsAt, endsAt } };
  }
}

/** When a part has nothing left to do */
function endOf(part: PartPlan): Date {
  return part.kind === 'lock' ? part.until : part.endsAt;
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

/** Seed for the earliest-start reduction; every plan has at least one part */
function part0Start(plan: Plan): Date {
  const first = plan.parts[0]!;
  return first.kind === 'lock' ? first.at : first.startsAt;
}

export default FlowRunner;
