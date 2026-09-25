import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { log } from '../utils/logger.ts';

interface Held {
  file: string;
  durationSec: number;
  timer: NodeJS.Timeout;
}

/**
 * Audio that came in through POST /uploads and is waiting to become a track.
 *
 * Note(yoochan.kim): an upload changes nothing about the device. addTrack is what makes
 * it a track, through the protocol like every other change. One nobody claims
 * is deleted when its time runs out, and any still here when the server stops
 * are cleared at the next boot with the rest of the staging files.
 */
class Uploads {
  private readonly held = new Map<string, Held>();

  constructor(private readonly ttlMs: number) {}

  /** Keeps a measured mp3 for addTrack, and answers the id to claim it with. */
  hold(file: string, durationSec: number): string {
    const id = `u-${randomBytes(8).toString('hex')}`;
    const timer = setTimeout(() => {
      this.held.delete(id);
      fs.rmSync(file, { force: true });
      log.info('uploads', null, 'Unclaimed upload deleted', { id });
    }, this.ttlMs);
    timer.unref();
    this.held.set(id, { file, durationSec, timer });
    return id;
  }

  /** Hands an upload over, once. The file is the caller's from here. */
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
