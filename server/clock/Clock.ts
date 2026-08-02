/**
 * The clock this building runs on.
 *
 * Standard time plus an offset someone set by hand, because the service follows
 * the clock on the sanctuary wall and that clock is a minute or two out. Every
 * instant on the wire is church time; this is the one place the two are
 * converted, so nothing downstream has to know the offset exists.
 */
class Clock {
  private offsetSec: number;
  private readonly listeners = new Set<(offsetSec: number) => void>();

  constructor(offsetSec: number) {
    this.offsetSec = offsetSec;
  }

  /** Church time, now. */
  now(): Date {
    return new Date(Date.now() + this.offsetSec * 1000);
  }

  offset(): number {
    return this.offsetSec;
  }

  /**
   * Moves the church clock. Callers are responsible for refusing this while a
   * flow is running: shifting the reference mid-run would drag the timeline
   * with it, since track boundaries are derived from wall-clock instants.
   */
  setOffset(offsetSec: number): void {
    if (offsetSec === this.offsetSec) return;
    this.offsetSec = offsetSec;
    for (const listener of this.listeners) listener(offsetSec);
  }

  onChange(listener: (offsetSec: number) => void): void {
    this.listeners.add(listener);
  }

  /** Milliseconds from now until a church-time instant; never negative. */
  msUntil(target: Date): number {
    return Math.max(0, target.getTime() - this.now().getTime());
  }

  /** Whether a church-time instant has already gone by. */
  hasPassed(target: Date): boolean {
    return this.now().getTime() >= target.getTime();
  }
}

export default Clock;
