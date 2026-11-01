import type Schedule from './Schedule.ts';
import { runsOn, secondsOf } from './Schedule.ts';
import type Clock from '../clock/Clock.ts';
import type FlowRunner from '../flow/FlowRunner.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

const TICK_MS = 5_000;
// Note(yoochan.kim): past this, starting is a person's call, and the dashboard offers the start key for it.
const GRACE_SEC = 5;

/** Note(yoochan.kim): here rather than in a browser, since a dashboard nobody has open is the normal case. */
class AutoStarter {
  private timer: NodeJS.Timeout | null = null;
  // Note(yoochan.kim): flow id on a day; not persisted, since a skip is about one service, not a setting.
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
        // Note(yoochan.kim): a bad tick must not end the loop, since next week's service depends on it.
        log.error('autostart', null, 'Tick failed', { error: errorMessage(error) });
      });
    }, TICK_MS);
  }

  dispose(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  skip(id: string): void {
    this.done.add(occurrence(id, this.clock.now()));
  }

  isSkipped(id: string): boolean {
    return this.done.has(occurrence(id, this.clock.now()));
  }

  private async tick(): Promise<void> {
    // Note(yoochan.kim): only one flow runs at a time, and the runner would refuse a second.
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

  /** Keeps the set from growing forever. */
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
