import fs from 'node:fs';
import path from 'node:path';
import type { ScheduleEntry, SchedulePart } from '../protocol.ts';
import { formatInstant } from '../utils/instant.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

/** Monday first, the way `Date.getDay()` is not. */
export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

// Note(yoochan.kim): seconds are optional. Track lengths are not whole minutes, so a
// finish that could only be set to the minute cannot say when the music stops.
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

/** What a flow needs to be handed to the runner: the same shape startFlow takes. */
export interface RunArgs {
  id: string;
  name: string;
  lock: { at: string; until: string };
  parts: { kind: 'music'; tracks: { id: string; volume: number }[]; endsAt: string }[];
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * The weekly calendar: which flows exist and when they may run.
 *
 * Note(yoochan.kim): this used to live in the admin web, on the principle that the server
 * is a device and a device has no calendar. It moved because a track cannot be
 * deleted while a flow still names it, and only whoever holds both the library
 * and the calendar can answer that. Everything that outlives a restart is the
 * server's now.
 *
 * Entries are wall-clock ("19:30"); which 19:30 is decided when one is started.
 */
class Schedule {
  private entries: ScheduleEntry[] = [];

  constructor(private readonly filePath: string) {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error(`Schedule file must be a JSON array: ${filePath}`);
    }
    for (const entry of parsed) {
      const checked = validate(entry);
      if (!checked.ok) {
        throw new Error(`Invalid schedule entry in ${filePath}: ${checked.reason}`);
      }
      if (this.entries.some((each) => each.id === checked.value.id)) {
        throw new Error(`Duplicate flow id in ${filePath}: ${checked.value.id}`);
      }
      this.entries.push(checked.value);
    }
  }

  list(): ScheduleEntry[] {
    return this.entries.map(copy);
  }

  get(id: string): ScheduleEntry | undefined {
    const found = this.entries.find((entry) => entry.id === id);
    return found ? copy(found) : undefined;
  }

  /** Every entry whose music names this track — what makes deleting it refusable. */
  usedBy(trackId: string): ScheduleEntry[] {
    return this.entries.filter((entry) => tracksOf(entry).includes(trackId)).map(copy);
  }

  /**
   * Writes one entry, replacing a known id in place so the calendar keeps its
   * order. Validated exactly as the file is at boot: what is saved here has to
   * be something the next boot will accept.
   */
  save(entry: unknown): Checked<ScheduleEntry> {
    const checked = validate(entry);
    if (!checked.ok) return checked;

    const at = this.entries.findIndex((each) => each.id === checked.value.id);
    const next = [...this.entries];
    if (at >= 0) next[at] = checked.value; else next.push(checked.value);
    this.entries = next;
    this.persist();
    return checked;
  }

  remove(id: string): boolean {
    const next = this.entries.filter((entry) => entry.id !== id);
    if (next.length === this.entries.length) return false;
    this.entries = next;
    this.persist();
    return true;
  }

  /**
   * Turns an entry into a run, against the day it is being started on.
   *
   * The runner takes instants only — it will not decide which day a bare
   * "19:30" belongs to. That decision belongs here, where the weekly calendar
   * is. `now` is church time, as every instant on the wire is.
   */
  toRunArgs(entry: ScheduleEntry, now: Date): RunArgs {
    const opensAt = onDay(now, entry.lock.at);

    const parts: RunArgs['parts'] = [];
    let musicEndsAt: Date | null = null;
    for (const part of entry.parts) {
      const endsAt = onDay(now, part.endsAt);
      // A finish before the gate opens is tomorrow's: a run crossing midnight.
      if (endsAt < opensAt) endsAt.setDate(endsAt.getDate() + 1);
      musicEndsAt = endsAt;
      parts.push({ kind: 'music', tracks: part.tracks.map((track) => ({ ...track })), endsAt: formatInstant(endsAt) });
    }

    let closesAt: Date;
    if (entry.lock.until.kind === 'music') {
      // Note(yoochan.kim): stated as an intent rather than a copied time, so moving the
      // music moves the gate with it. Validation guarantees the music exists.
      closesAt = musicEndsAt!;
    } else {
      closesAt = onDay(now, entry.lock.until.at);
      if (closesAt <= opensAt) closesAt.setDate(closesAt.getDate() + 1);
    }

    return {
      id: entry.id,
      name: entry.name,
      lock: { at: formatInstant(opensAt), until: formatInstant(closesAt) },
      parts,
    };
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.entries, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      log.error('schedule', null, 'Failed to write the schedule', { error: errorMessage(error) });
    }
  }
}

/** Whether an entry may run on a given church-time day. */
export function runsOn(entry: ScheduleEntry, day: Date): boolean {
  // getDay() counts Sunday first; the calendar counts Monday first.
  return entry.weekdays.includes(WEEKDAY_KEYS[(day.getDay() + 6) % 7]!);
}

/** Every track id an entry names, in play order. */
export function tracksOf(entry: ScheduleEntry): string[] {
  return entry.parts.flatMap((part) => part.tracks.map((track) => track.id));
}

/** Seconds since midnight, from HH:MM or HH:MM:SS. */
export function secondsOf(clock: string): number {
  const parts = clock.split(':').map(Number);
  return parts[0]! * 3600 + parts[1]! * 60 + (parts[2] ?? 0);
}

function onDay(now: Date, clock: string): Date {
  const parts = clock.split(':').map(Number);
  const at = new Date(now);
  at.setHours(parts[0]!, parts[1]!, parts[2] ?? 0, 0);
  return at;
}

function copy(entry: ScheduleEntry): ScheduleEntry {
  return {
    ...entry,
    weekdays: [...entry.weekdays],
    lock: { at: entry.lock.at, until: { ...entry.lock.until } },
    parts: entry.parts.map((part) => ({ ...part, tracks: part.tracks.map((track) => ({ ...track })) })),
  };
}

/**
 * One entry, checked the same way whether it came from the file or the wire.
 *
 * Note(yoochan.kim): the reasons are sentences rather than codes because they are read
 * twice — in a boot failure, where the file has to say what is wrong with it,
 * and by whoever is editing, where the caller turns them into a refusal.
 */
export function validate(value: unknown): Checked<ScheduleEntry> {
  if (typeof value !== 'object' || value === null) return bad('an entry must be an object');
  const entry = value as Record<string, unknown>;

  const { id, name, weekdays, autoStart, lock } = entry;
  const parts = entry.parts ?? [];
  if (typeof id !== 'string' || id.length === 0) return bad('id must be a non-empty string');
  if (typeof name !== 'string' || name.length === 0) return bad(`${id}: name must be a non-empty string`);
  if (!Array.isArray(weekdays) || weekdays.length === 0) return bad(`${id}: weekdays must be a non-empty list`);
  for (const day of weekdays) {
    if (!WEEKDAY_KEYS.includes(day as typeof WEEKDAY_KEYS[number])) return bad(`${id}: unknown weekday ${JSON.stringify(day)} (use mon..sun)`);
  }
  if (typeof autoStart !== 'boolean') return bad(`${id}: autoStart must be true or false`);
  if (!Array.isArray(parts)) return bad(`${id}: parts must be a list`);

  const checkedParts: SchedulePart[] = [];
  for (const part of parts) {
    const checked = validatePart(id, part);
    if (!checked.ok) return checked;
    if (checkedParts.some((each) => each.kind === checked.value.kind)) return bad(`${id}: ${checked.value.kind} appears more than once`);
    checkedParts.push(checked.value);
  }

  // Note(yoochan.kim): every flow holds the gate. Music on an open panel can be taken over
  // from the tablet mid-run, so a flow without a lock is not a flow.
  const checkedLock = validateLock(id, lock, checkedParts);
  if (!checkedLock.ok) return checkedLock;

  const covered = musicIsCovered(id, checkedLock.value, checkedParts);
  if (!covered.ok) return covered;

  return {
    ok: true,
    value: {
      id,
      name,
      weekdays: weekdays as string[],
      autoStart,
      lock: checkedLock.value,
      parts: checkedParts,
    },
  };
}

/**
 * Whether the music finishes inside the gate window.
 *
 * Note(yoochan.kim): measured as distance after the gate opens, not as clock times, so a
 * window that runs past midnight is one interval rather than two. The runner
 * refuses this too, but only when start is pressed — which is during a service.
 * The same rule here catches it while somebody is still editing.
 */
function musicIsCovered(id: string, lock: ScheduleEntry['lock'], parts: SchedulePart[]): Checked<true> {
  const music = parts.find((part) => part.kind === 'music');
  if (!music) return { ok: true, value: true };

  const opens = secondsOf(lock.at);
  const after = (clock: string): number => ((secondsOf(clock) - opens) % 86400 + 86400) % 86400;

  const ends = after(music.endsAt);
  if (ends === 0) return bad(`${id}: the music ends the moment the gate opens, so it could never sound`);
  const closes = lock.until.kind === 'music' ? ends : after(lock.until.at);
  if (closes === 0) return bad(`${id}: the gate would close the moment it opens`);
  if (ends > closes) return bad(`${id}: the music ends after the gate opens again`);
  return { ok: true, value: true };
}

function validateLock(id: string, value: unknown, parts: SchedulePart[]): Checked<ScheduleEntry['lock']> {
  if (typeof value !== 'object' || value === null) return bad(`${id}: lock is required`);
  const lock = value as Record<string, unknown>;
  if (!isClock(lock.at)) return bad(`${id}: lock.at must be HH:MM or HH:MM:SS, got ${JSON.stringify(lock.at)}`);

  const until = lock.until;
  if (typeof until !== 'object' || until === null) return bad(`${id}: lock.until must be an object`);
  const kind = (until as Record<string, unknown>).kind;
  const music = parts.find((part) => part.kind === 'music');

  if (kind === 'music') {
    if (!music) return bad(`${id}: lock.until follows the music, but there is none`);
    return { ok: true, value: { at: lock.at, until: { kind: 'music' } } };
  }
  if (kind === 'clock') {
    const at = (until as Record<string, unknown>).at;
    if (!isClock(at)) return bad(`${id}: lock.until.at must be HH:MM or HH:MM:SS, got ${JSON.stringify(at)}`);
    return { ok: true, value: { at: lock.at, until: { kind: 'clock', at } } };
  }
  return bad(`${id}: unknown lock.until kind ${JSON.stringify(kind)} (use music or clock)`);
}

function validatePart(id: string, value: unknown): Checked<SchedulePart> {
  if (typeof value !== 'object' || value === null) return bad(`${id}: each part must be an object`);
  const part = value as Record<string, unknown>;
  if (part.kind !== 'music') return bad(`${id}: unknown part kind ${JSON.stringify(part.kind)} (only music today)`);
  if (!isClock(part.endsAt)) return bad(`${id}: endsAt must be HH:MM or HH:MM:SS, got ${JSON.stringify(part.endsAt)}`);

  const tracks = part.tracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return bad(`${id}: music needs at least one track`);
  const checked: { id: string; volume: number }[] = [];
  for (const track of tracks) {
    if (typeof track !== 'object' || track === null) return bad(`${id}: each music track must be an object`);
    const cue = track as Record<string, unknown>;
    if (typeof cue.id !== 'string' || cue.id.length === 0) return bad(`${id}: each music track needs an id`);
    // Note(yoochan.kim): the level is always given. A run should sound the way it was
    // written, not inherit whatever the panel was left at.
    if (typeof cue.volume !== 'number' || !Number.isInteger(cue.volume) || cue.volume < 0 || cue.volume > 100) {
      return bad(`${id}: track ${cue.id} needs a volume between 0 and 100`);
    }
    checked.push({ id: cue.id, volume: cue.volume });
  }
  return { ok: true, value: { kind: 'music', tracks: checked, endsAt: part.endsAt } };
}

function isClock(value: unknown): value is string {
  return typeof value === 'string' && CLOCK.test(value);
}

function bad(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

export default Schedule;
