import type Schedule from './Schedule.ts';
import { runsOn, secondsOf } from './Schedule.ts';
import type Clock from '../clock/Clock.ts';
import type FlowRunner from '../flow/FlowRunner.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

const TICK_MS = 5_000;
// Note(yoochan.kim): only the moment itself is the runner's. Past this, starting is a
// person's call, and the dashboard offers the start key for exactly that case.
const GRACE_SEC = 5;

/**
 * Starts calendar entries marked autoStart when their window opens.
 *
 * Note(yoochan.kim): this runs here rather than in a browser because a dashboard nobody
 * has open is the normal case, and a service that runs itself has to run
 * whether or not anyone is watching.
 */
class AutoStarter {
  private timer: NodeJS.Timeout | null = null;
  // Note(yoochan.kim): one occurrence each — "flow id on this day" already started or
  // passed over. Not persisted: a skip is about one service, not a setting.
  private done = new Set<string>();

  constructor(
    private readonly schedule: Schedule,
    private readonly clock: Clock,
    private readonly flowRunner: FlowRunner,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        // A bad tick must not end the loop: next week's service depends on it.
        log.error('autostart', null, 'Tick failed', { error: errorMessage(error) });
      });
    }, TICK_MS);
  }

  dispose(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Passes over today's occurrence. Next week is unaffected. */
  skip(id: string): void {
    this.done.add(occurrence(id, this.clock.now()));
  }

  isSkipped(id: string): boolean {
    return this.done.has(occurrence(id, this.clock.now()));
  }

  private async tick(): Promise<void> {
    // Only one flow runs at a time, and the runner would refuse a second.
    if (this.flowRunner.status().phase !== 'idle') return;

    const now = this.clock.now();
    this.prune(now);

    for (const entry of this.schedule.list()) {
      if (!entry.autoStart || !runsOn(entry, now)) continue;
      const key = occurrence(entry.id, now);
      if (this.done.has(key)) continue;

      const sinceOpen = secondsOfDay(now) - secondsOf(entry.lock.at);
      if (sinceOpen < 0 || sinceOpen >= GRACE_SEC) continue;

      this.done.add(key);
      log.info('autostart', null, 'Starting a scheduled flow', { id: entry.id, name: entry.name });
      const started = await this.flowRunner.start(this.schedule.toRunArgs(entry, now));
      if (!started.ok) {
        log.error('autostart', null, 'The runner refused a scheduled flow', { id: entry.id, reason: started.reason });
      }
      return;
    }
  }

  /** Drops occurrences from other days so the set cannot grow forever. */
  private prune(now: Date): void {
    const today = dayKey(now);
    this.done = new Set([...this.done].filter((key) => key.endsWith(today)));
  }
}

function occurrence(id: string, day: Date): string {
  return `${id}|${dayKey(day)}`;
}

function dayKey(day: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

function secondsOfDay(at: Date): number {
  return at.getHours() * 3600 + at.getMinutes() * 60 + at.getSeconds();
}

export default AutoStarter;
