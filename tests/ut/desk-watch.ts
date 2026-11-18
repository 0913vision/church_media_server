import type { DeskWatch } from '../../server/console/DeskHolds.ts';
import type { DeskNote } from '../../server/protocol.ts';

/** A watch for holds in a test: keeps the notes it is handed and counts what a screen would have been told. */
export function testWatch(notes: readonly DeskNote[] = []): DeskWatch & { kept: DeskNote[][]; told: number } {
  const watch = {
    kept: [] as DeskNote[][],
    told: 0,
    notes,
    now: () => new Date(),
    keep(next: readonly DeskNote[]) { watch.kept.push([...next]); },
    changed() { watch.told += 1; },
  };
  return watch;
}
