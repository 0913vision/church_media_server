import MpvClient from './MpvClient.ts';
import { DEVICE_CONFIG } from '../constants/deviceConfig.ts';
import type { SongId } from '../constants/songs.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';
import type { AudioOutput } from './AudioOutput.ts';
import { dbFromLevel, fadeInDb, fadeOutDb, mpvVolumeFromDb } from './loudness.ts';

class AudioDevice implements AudioOutput {
  private readonly playlist: Record<SongId, string>;
  /** The level last set, 0–100; fades move around it. mpv's own 100 until someone sets one. */
  private level = 100;
  private readonly currentSongTimes: Record<SongId, number>;

  /** initialSong and playlist are handed in: the player's defaults and the track manifest own them. */
  constructor(
    private readonly mpv: MpvClient,
    private readonly initialSong: SongId,
    playlist: Record<SongId, string>,
  ) {
    this.playlist = { ...playlist };
    this.currentSongTimes = Object.fromEntries(Object.keys(playlist).map((song) => [song, 0]));
    this.initialize();
  }

  // Note(yoochan.kim): song ids come from the manifest, so an unknown one is a caller's bug, not a silent no-op.
  private fileOf(song: SongId): string {
    const file = this.playlist[song];
    if (file === undefined) throw new Error(`No audio file for song '${song}'`);
    return file;
  }

  /** Note(yoochan.kim): asked of mpv rather than worked out from a clock, since a track can sit paused part-way. */
  hasEnded(): boolean {
    try {
      // Note(yoochan.kim): not eof-reached: mpv unloads a file at its end, and a gone file's property reads null.
      return this.mpv.getProperty("idle-active") === "yes";
    } catch (error) {
      log.error('audioDevice', null, 'Failed to read idle-active', { error: errorMessage(error) });
      return false;
    }
  }

  /** Whether what is loaded repeats, applied to the file already playing. */
  setLoop(loop: boolean): void {
    try {
      this.mpv.setProperty("loop", loop ? "inf" : "no");
    } catch (error) {
      log.error('audioDevice', null, 'Failed to set loop property', { loop, error: errorMessage(error) });
    }
  }

  private initialize(): void {
    try {
      this.mpv.setProperty("loop", "inf");
    } catch (error) {
      log.error('audioDevice', null, 'Failed to set loop property', { error: errorMessage(error) });
    }

    try {
      this.mpv.executeCommand(["loadfile", this.fileOf(this.initialSong), null]);
    } catch (error) {
      log.error('audioDevice', null, 'Failed to load initial file', { file: this.playlist[this.initialSong], error: errorMessage(error) });
    }

    try {
      this.mpv.setProperty("pause", "yes");
    } catch (error) {
      log.error('audioDevice', null, 'Failed to set pause property', { error: errorMessage(error) });
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** null rather than 0, so a caller keeps the position it saved instead of overwriting it with a bogus one. */
  private getCurrentSongTime(): number | null {
    try {
      const response = this.mpv.getProperty("playback-time");
      const parsed = parseFloat(response ?? '');
      return Number.isFinite(parsed) ? parsed : null;
    } catch (error) {
      log.error('audioDevice', null, 'Failed to get playback time', { error: errorMessage(error) });
      return null;
    }
  }

  /** SEEK_AUDIBLE_SEC is the line a run uses to tell a track joined part-way, so both answer alike. */
  isPartWay(): boolean {
    const at = this.getCurrentSongTime();
    // Note(yoochan.kim): a position mpv cannot give yet is a file still opening, which is at its start.
    return at !== null && at > DEVICE_CONFIG.SEEK_AUDIBLE_SEC;
  }

  position(): number | null {
    return this.getCurrentSongTime();
  }

  /** Puts mpv at some decibels under the file's own level. */
  private setDb(db: number): void {
    this.mpv.setProperty("volume", mpvVolumeFromDb(db).toString());
  }

  /** The level is read every step, so one moved during a fade is the one it lands on. */
  private async fadeAlong(curve: typeof fadeInDb, durationMs: number): Promise<void> {
    const step = DEVICE_CONFIG.FADE_STEP_MS;
    let t = 0;
    while (t + step < durationMs) {
      t += step;
      await this.delay(step);
      this.setDb(dbFromLevel(this.level) + curve(t, durationMs, DEVICE_CONFIG.FADE_EDGE_DB));
    }
    await this.delay(durationMs - t);
  }

  async pause(fade = true, durationMs: number = DEVICE_CONFIG.FADE_OUT_MS): Promise<void> {
    if (!fade) {
      this.mpv.setProperty("pause", "yes");
      return;
    }
    await this.fadeAlong(fadeOutDb, durationMs);
    this.mpv.setProperty("pause", "yes");
    this.setDb(dbFromLevel(this.level));
  }

  async resume(fade = true, onSounding?: () => void, durationMs: number = DEVICE_CONFIG.FADE_IN_MS): Promise<void> {
    if (!fade) {
      this.mpv.setProperty("pause", "no");
      onSounding?.();
      return;
    }
    this.setDb(dbFromLevel(this.level) + fadeInDb(0, durationMs, DEVICE_CONFIG.FADE_EDGE_DB));
    this.mpv.setProperty("pause", "no");
    onSounding?.();
    await this.fadeAlong(fadeInDb, durationMs);
    this.setDb(dbFromLevel(this.level));
  }

  /** 0–100 on the X32 fader's shape (see loudness.ts); 0 is silence. */
  setVolume(volume: number): void {
    this.level = volume;
    this.setDb(dbFromLevel(volume));
  }

  captureSongTime(song: SongId): void {
    const currentTime = this.getCurrentSongTime();
    if (currentTime !== null) {
      this.currentSongTimes[song] = currentTime;
    }
  }

  loadSong(song: SongId): void {
    // Note(yoochan.kim): the panel's songs loop forever, and a library track may have switched looping off.
    this.mpv.setProperty("loop", "inf");

    try {
      this.mpv.executeCommand(["loadfile", this.fileOf(song), null]);
    } catch (error) {
      log.error('audioDevice', null, 'Failed to load song', {
        song,
        file: this.playlist[song],
        error: errorMessage(error)
      });
      throw error;
    }
  }

  /** The read-back can be a frame off, and null right after a load; both retry, never pass as success. */
  private async setPlaybackTime(targetTime: number): Promise<void> {
    let attempts = 0;
    let succeeded = false;

    do {
      this.mpv.setProperty("playback-time", targetTime.toString(), true);
      await this.delay(DEVICE_CONFIG.PROPERTY_SET_RETRY_DELAY_MS);
      attempts++;

      const currentTime = parseFloat(this.mpv.getProperty("playback-time") ?? '');
      succeeded = Math.abs(currentTime - targetTime) <= DEVICE_CONFIG.PLAYBACK_TIME_TOLERANCE_SEC;
    } while (!succeeded && attempts < DEVICE_CONFIG.MAX_PROPERTY_SET_ATTEMPTS);

    if (!succeeded) {
      throw new Error(`Failed to set playback time after ${attempts} attempts`);
    }
  }

  async loadLastSongTime(song: SongId): Promise<void> {
    const targetTime = this.currentSongTimes[song] ?? 0;
    try {
      await this.setPlaybackTime(targetTime);
    } catch (error) {
      log.error('audioDevice', null, 'Failed to load last song time', {
        song,
        targetTime,
        error: errorMessage(error)
      });
      throw error;
    }
  }

  /** Looping is the caller's: a flow's track runs once and ends on time, but an admin may want one repeated. */
  loadFile(filePath: string, loop: boolean): void {
    this.mpv.setProperty("pause", "yes");
    this.mpv.setProperty("loop", loop ? "inf" : "no");
    try {
      this.mpv.executeCommand(["loadfile", filePath, null]);
    } catch (error) {
      log.error('audioDevice', null, 'Failed to load track file', { filePath, error: errorMessage(error) });
      throw error;
    }
  }

  /** Note(yoochan.kim): gapless when the formats match (mpv's gapless-audio=weak); every file on the Pi is 44.1kHz stereo. */
  queueFile(filePath: string): void {
    try {
      this.mpv.executeCommand(["loadfile", filePath, "append", null]);
    } catch (error) {
      log.error('audioDevice', null, 'Failed to queue track file', { filePath, error: errorMessage(error) });
      throw error;
    }
  }

  clearQueue(): void {
    try {
      this.mpv.executeCommand(["playlist-clear", null]);
    } catch (error) {
      log.error('audioDevice', null, 'Failed to clear the queue', { error: errorMessage(error) });
    }
  }

  playingFile(): string | null {
    try {
      return this.mpv.getProperty("path");
    } catch (error) {
      log.error('audioDevice', null, 'Failed to read the playing file', { error: errorMessage(error) });
      return null;
    }
  }

  async playFileAt(filePath: string, offsetSec: number, loop = false, fadeLimitMs = Infinity): Promise<void> {
    this.mpv.setProperty("pause", "yes");
    this.mpv.setProperty("loop", loop ? "inf" : "no");

    try {
      this.mpv.executeCommand(["loadfile", filePath, null]);
    } catch (error) {
      log.error('audioDevice', null, 'Failed to load track file', { filePath, error: errorMessage(error) });
      throw error;
    }

    // Note(yoochan.kim): a timer firing a ms or two late is on time: no seek, which costs tens of ms, and no fade.
    const joined = offsetSec > DEVICE_CONFIG.SEEK_AUDIBLE_SEC;
    if (joined) {
      try {
        await this.setPlaybackTime(offsetSec);
      } catch (error) {
        log.error('audioDevice', null, 'Failed to seek track', { filePath, offsetSec, error: errorMessage(error) });
        throw error;
      }
    }

    // Note(yoochan.kim): joined part-way the fade covers a cut, but never past the end, or the next thing starts late.
    await this.resume(joined, undefined, Math.min(DEVICE_CONFIG.FADE_IN_MS, fadeLimitMs));
  }
}

export default AudioDevice;
