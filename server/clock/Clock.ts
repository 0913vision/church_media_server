/** Standard time plus a hand-set offset, since the service follows the sanctuary wall clock; converted only here. */
class Clock {
  private offsetSec: number;
  private readonly listeners = new Set<(offsetSec: number) => void>();

  constructor(offsetSec: number) {
    this.offsetSec = offsetSec;
  }

  now(): Date {
    return new Date(Date.now() + this.offsetSec * 1000);
  }

  offset(): number {
    return this.offsetSec;
  }

  /** Callers must refuse this mid-run: track boundaries are wall-clock instants, so the timeline would move. */
  setOffset(offsetSec: number): void {
    if (offsetSec === this.offsetSec) return;
    this.offsetSec = offsetSec;
    for (const listener of this.listeners) listener(offsetSec);
  }

  onChange(listener: (offsetSec: number) => void): void {
    this.listeners.add(listener);
  }

  msUntil(target: Date): number {
    return Math.max(0, target.getTime() - this.now().getTime());
  }

  hasPassed(target: Date): boolean {
    return this.now().getTime() >= target.getTime();
  }
}

export default Clock;
