import fs from 'node:fs';
import path from 'node:path';
import type { ScheduleEntry, SchedulePart } from '../protocol.ts';
import { isBeforeSec } from '../tracks/TrackLibrary.ts';
import { formatInstant } from '../utils/instant.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

/** Monday first, the way `Date.getDay()` is not. */
export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

// Note(yoochan.kim): seconds are optional, as a finish set only to the minute cannot say when the music stops.
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

/** The same shape startFlow takes. */
export interface RunArgs {
  id: string;
  name: string;
  lock: { at: string; until: string };
  parts: (
    | { kind: 'music'; tracks: { id: string; volume: number }[]; endsAt: string }
    | { kind: 'countdown'; at: string; notices: number[] }
  )[];
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Note(yoochan.kim): beside the library, since only whoever holds both can refuse deleting a track a flow names. */
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

  /** What makes deleting a track refusable. */
  usedBy(trackId: string): ScheduleEntry[] {
    return this.entries.filter((entry) => tracksOf(entry).includes(trackId)).map(copy);
  }

  /** Validated as the file is at boot, so nothing saved here can be refused by the next boot. */
  save(entry: unknown): Checked<ScheduleEntry> {
    const checked = validate(entry);
    if (!checked.ok) return checked;

    const at = this.entries.findIndex((each) => each.id === checked.value.id);
    const next = [...this.entries];
    // Note(yoochan.kim): a known id is replaced in place, so the calendar keeps its order.
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

  /** The runner takes instants only, so the day a wall-clock entry falls on is decided here; `now` is church time. */
  toRunArgs(entry: ScheduleEntry, now: Date): RunArgs {
    const opensAt = onDay(now, entry.lock.at);

    const parts: RunArgs['parts'] = [];
    let lastSound: Date | null = null;
    for (const part of entry.parts) {
      const ends = onDay(now, part.kind === 'music' ? part.endsAt : part.at);
      // Note(yoochan.kim): an end before the gate opens is tomorrow's, a run crossing midnight.
      if (ends < opensAt) ends.setDate(ends.getDate() + 1);
      if (!lastSound || ends > lastSound) lastSound = ends;
      parts.push(part.kind === 'music'
        ? { kind: 'music', tracks: part.tracks.map((track) => ({ ...track })), endsAt: formatInstant(ends) }
        : { kind: 'countdown', at: formatInstant(ends), notices: [...part.notices] });
    }

    let closesAt: Date;
    if (entry.lock.until.kind === 'music') {
      // Note(yoochan.kim): an intent, so moving the last sound moves the gate; validation ensures there is one.
      closesAt = lastSound!;
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

export function runsOn(entry: ScheduleEntry, day: Date): boolean {
  // Note(yoochan.kim): getDay() counts Sunday first; the calendar counts Monday first.
  return entry.weekdays.includes(WEEKDAY_KEYS[(day.getDay() + 6) % 7]!);
}

export function tracksOf(entry: ScheduleEntry): string[] {
  return entry.parts.flatMap((part) => (part.kind === 'music' ? part.tracks.map((track) => track.id) : []));
}

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
    parts: entry.parts.map((part) => (part.kind === 'music'
      ? { ...part, tracks: part.tracks.map((track) => ({ ...track })) }
      : { ...part, notices: [...part.notices] })),
  };
}

/** Note(yoochan.kim): reasons are sentences, read both in a boot failure and by whoever is editing the entry. */
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

  // Note(yoochan.kim): every flow holds the gate, since music on an open panel can be taken over from the tablet.
  const checkedLock = validateLock(id, lock, checkedParts);
  if (!checkedLock.ok) return checkedLock;

  const covered = partsAreCovered(id, checkedLock.value, checkedParts);
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

/** Note(yoochan.kim): offsets from the gate keep midnight one interval; the runner checks too, but only mid-service. */
function partsAreCovered(id: string, lock: ScheduleEntry['lock'], parts: SchedulePart[]): Checked<true> {
  if (parts.length === 0) return { ok: true, value: true };

  const opens = secondsOf(lock.at);
  const after = (clock: string): number => ((secondsOf(clock) - opens) % 86400 + 86400) % 86400;
  const ends = parts.map((part) => ({ what: part.kind === 'music' ? 'the music ends' : 'the countdown reaches zero', at: after(part.kind === 'music' ? part.endsAt : part.at) }));

  for (const end of ends) {
    if (end.at === 0) return bad(`${id}: ${end.what} the moment the gate opens, so it could never sound`);
  }
  const closes = lock.until.kind === 'music' ? Math.max(...ends.map((end) => end.at)) : after(lock.until.at);
  if (closes === 0) return bad(`${id}: the gate would close the moment it opens`);
  for (const end of ends) {
    if (end.at > closes) return bad(`${id}: ${end.what} after the gate opens again`);
  }
  return { ok: true, value: true };
}

function validateLock(id: string, value: unknown, parts: SchedulePart[]): Checked<ScheduleEntry['lock']> {
  if (typeof value !== 'object' || value === null) return bad(`${id}: lock is required`);
  const lock = value as Record<string, unknown>;
  if (!isClock(lock.at)) return bad(`${id}: lock.at must be HH:MM or HH:MM:SS, got ${JSON.stringify(lock.at)}`);

  const until = lock.until;
  if (typeof until !== 'object' || until === null) return bad(`${id}: lock.until must be an object`);
  const kind = (until as Record<string, unknown>).kind;

  if (kind === 'music') {
    if (parts.length === 0) return bad(`${id}: lock.until follows the last sound, but there is no music or countdown`);
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
  if (part.kind === 'countdown') return validateCountdown(id, part);
  if (part.kind !== 'music') return bad(`${id}: unknown part kind ${JSON.stringify(part.kind)} (use music or countdown)`);
  if (!isClock(part.endsAt)) return bad(`${id}: endsAt must be HH:MM or HH:MM:SS, got ${JSON.stringify(part.endsAt)}`);

  const tracks = part.tracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return bad(`${id}: music needs at least one track`);
  const checked: { id: string; volume: number }[] = [];
  for (const track of tracks) {
    if (typeof track !== 'object' || track === null) return bad(`${id}: each music track must be an object`);
    const cue = track as Record<string, unknown>;
    if (typeof cue.id !== 'string' || cue.id.length === 0) return bad(`${id}: each music track needs an id`);
    // Note(yoochan.kim): always given, so a run sounds as written rather than at whatever the panel was left at.
    if (typeof cue.volume !== 'number' || !Number.isInteger(cue.volume) || cue.volume < 0 || cue.volume > 100) {
      return bad(`${id}: track ${cue.id} needs a volume between 0 and 100`);
    }
    checked.push({ id: cue.id, volume: cue.volume });
  }
  return { ok: true, value: { kind: 'music', tracks: checked, endsAt: part.endsAt } };
}

/** A countdown: when it reaches zero, and which notices go ahead of the count. */
function validateCountdown(id: string, part: Record<string, unknown>): Checked<SchedulePart> {
  if (!isClock(part.at)) return bad(`${id}: the countdown's at must be HH:MM or HH:MM:SS, got ${JSON.stringify(part.at)}`);
  const notices = part.notices;
  if (!Array.isArray(notices)) return bad(`${id}: the countdown's notices must be a list`);
  for (const notice of notices) {
    if (!isBeforeSec(notice)) return bad(`${id}: a notice is seconds before zero, a whole number above 0, got ${JSON.stringify(notice)}`);
  }
  if (new Set(notices).size !== notices.length) return bad(`${id}: a notice appears more than once`);
  return { ok: true, value: { kind: 'countdown', at: part.at, notices: notices as number[] } };
}

function isClock(value: unknown): value is string {
  return typeof value === 'string' && CLOCK.test(value);
}

function bad(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

export default Schedule;
