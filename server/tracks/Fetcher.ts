import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { RejectReason } from '../protocol.ts';
import type { FetchProgress, TrackFetch } from '../protocol.ts';
import { TRACK_CONFIG } from '../constants/trackConfig.ts';
import { measureMp3 } from './probe.ts';
import { log } from '../utils/logger.ts';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);

/** Whether an address is YouTube's */
export function isYoutube(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && YOUTUBE_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export type Fetched = { ok: true; file: string; durationSec: number } | { ok: false; reason: RejectReason };

/** yt-dlp's own words for how far it has got, one line each with --newline */
const DOWNLOADING = /^\[download\]\s+(\d+(?:\.\d+)?)%/;
const CONVERTING = /^\[ExtractAudio\]/;

/**
 * Fetches a YouTube video's audio as an mp3, one video at a time.
 *
 * Note(yoochan.kim): yt-dlp does the fetching. It is the one tool that keeps up with
 * YouTube, and when fetching stops working, updating it is usually the fix. It
 * writes only under a staging name in the audio folder, so a fetch cut short by
 * a restart is cleared at the next boot like any other.
 */
class Fetcher {
  private current: { title: string; progress: FetchProgress } | undefined;
  private reportedAt = 0;

  constructor(private readonly ytdlp: string) {}

  status(): TrackFetch {
    return this.current === undefined
      ? { kind: 'idle' }
      : { kind: 'fetching', title: this.current.title, progress: { ...this.current.progress } };
  }

  busy(): boolean {
    return this.current !== undefined;
  }

  /**
   * Fetches `url` into `base`.mp3. Claims the one fetch slot before it first
   * waits, so status() says fetching as soon as this is called. The caller
   * has checked the address and that the slot was free. `onProgress` is called
   * when the stage changes, and at most once a second while a download counts up.
   */
  async fetch(url: string, title: string, base: string, onProgress: () => void): Promise<Fetched> {
    this.current = { title, progress: { stage: 'starting' } };
    this.reportedAt = 0;
    try {
      const fetched = await this.run(url, base, (progress) => this.advance(progress, onProgress));
      clearStaging(base, fetched.ok ? fetched.file : undefined);
      return fetched;
    } finally {
      this.current = undefined;
    }
  }

  private advance(progress: FetchProgress, onProgress: () => void): void {
    const now = this.current;
    if (!now) return;
    const newStage = now.progress.stage !== progress.stage;
    now.progress = progress;
    // Note(yoochan.kim): a new stage is said at once, a percentage only once the interval has passed
    if (!newStage && Date.now() - this.reportedAt < TRACK_CONFIG.FETCH_PROGRESS_INTERVAL_MS) return;
    this.reportedAt = Date.now();
    onProgress();
  }

  private async run(url: string, base: string, report: (progress: FetchProgress) => void): Promise<Fetched> {
    const file = `${base}.mp3`;
    const { error, output } = await new Promise<{ error: ExecFileException | null; output: string }>((resolve) => {
      const child = execFile(this.ytdlp, [
        '--no-playlist', '--newline',
        '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
        '--max-filesize', String(TRACK_CONFIG.MAX_BYTES),
        '--output', `${base}.%(ext)s`,
        '--', url,
      ], { timeout: TRACK_CONFIG.FETCH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (failed, stdout, stderr) => {
        resolve({ error: failed, output: `${stdout}${stderr}` });
      });

      let pending = '';
      child.stdout?.on('data', (chunk: string) => {
        const lines = (pending + chunk).split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const downloading = DOWNLOADING.exec(line);
          if (downloading) report({ stage: 'downloading', percent: Math.min(100, Math.floor(Number(downloading[1]))) });
          else if (CONVERTING.test(line)) report({ stage: 'converting' });
        }
      });
    });

    if (error) {
      if (error.code === 'ENOENT') {
        log.error('fetch', null, 'yt-dlp not found', { path: this.ytdlp });
      } else if (error.killed) {
        log.warn('fetch', null, 'Fetch took too long, given up', { url });
      } else {
        log.warn('fetch', null, 'Fetch failed', { url, output: output.slice(-300) });
      }
      return { ok: false, reason: RejectReason.FETCH_FAILED };
    }

    // Note(yoochan.kim): yt-dlp stops a download past the size limit and still exits cleanly
    if (!fs.existsSync(file)) {
      const tooLarge = /max-filesize/.test(output);
      log.warn('fetch', null, tooLarge ? 'Fetch refused: too large' : 'Fetch left no file', { url, output: output.slice(-300) });
      return { ok: false, reason: tooLarge ? RejectReason.TOO_LARGE : RejectReason.FETCH_FAILED };
    }
    if (fs.statSync(file).size > TRACK_CONFIG.MAX_BYTES) {
      log.warn('fetch', null, 'Fetch refused: too large once converted', { url });
      return { ok: false, reason: RejectReason.TOO_LARGE };
    }

    const durationSec = await measureMp3(file);
    if (durationSec === null) {
      log.warn('fetch', null, 'Fetch produced no playable mp3', { url });
      return { ok: false, reason: RejectReason.FETCH_FAILED };
    }
    log.info('fetch', null, 'Fetched', { url, durationSec });
    return { ok: true, file, durationSec };
  }
}

/** Removes what a fetch wrote under `base`, but the file it is handing over. */
function clearStaging(base: string, keep: string | undefined): void {
  const dir = path.dirname(base);
  const prefix = `${path.basename(base)}.`;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (name.startsWith(prefix) && file !== keep) fs.rmSync(file, { force: true });
  }
}

export default Fetcher;
