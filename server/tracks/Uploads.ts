import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { log } from '../utils/logger.ts';

interface Held {
  file: string;
  durationSec: number;
  timer: NodeJS.Timeout;
}

/** Note(yoochan.kim): an upload changes nothing on the device; only addTrack, over the protocol, makes it a track. */
class Uploads {
  private readonly held = new Map<string, Held>();

  constructor(private readonly ttlMs: number) {}

  hold(file: string, durationSec: number): string {
    const id = `u-${randomBytes(8).toString('hex')}`;
    const timer = setTimeout(() => {
      this.held.delete(id);
      fs.rmSync(file, { force: true });
      log.info('uploads', null, 'Unclaimed upload deleted', { id });
    }, this.ttlMs);
    // Note(yoochan.kim): one still here when the server stops is cleared at the next boot with the other staging files.
    timer.unref();
    this.held.set(id, { file, durationSec, timer });
    return id;
  }

  /** The file is the caller's from here. */
  take(id: string): { file: string; durationSec: number } | undefined {
    const held = this.held.get(id);
    if (!held) return undefined;
    clearTimeout(held.timer);
    this.held.delete(id);
    return { file: held.file, durationSec: held.durationSec };
  }

  dispose(): void {
    for (const { timer } of this.held.values()) clearTimeout(timer);
  }
}

export default Uploads;
