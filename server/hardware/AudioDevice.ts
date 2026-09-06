import MpvClient from './MpvClient.ts';
import { DEVICE_CONFIG } from '../constants/deviceConfig.ts';
import type { SongId } from '../constants/songs.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';
import type { AudioOutput } from './AudioOutput.ts';

/**
 * High-level device controller that manages audio playback operations
 */
class AudioDevice implements AudioOutput {
  private readonly playlist: Record<SongId, string>;
  private readonly currentSongTimes: Record<SongId, number>;

  /**
   * @param mpv - Low-level MPV client (injected by the composition root)
   * @param initialSong - Song to load on startup (the player's initial current
   *   song, injected so this layer isn't coupled to player defaults)
   * @param playlist - Audio file per song, from the track manifest — the one
   *   place every audio asset is registered
   */
  constructor(
    private readonly mpv: MpvClient,
    private readonly initialSong: SongId,
    playlist: Record<SongId, string>,
  ) {
    this.playlist = { ...playlist };
    // Note(yoochan.kim): every song starts at its beginning; which songs there
    // are is the manifest's answer, arriving here as the playlist
    this.currentSongTimes = Object.fromEntries(Object.keys(playlist).map((song) => [song, 0]));
    this.initialize();
  }

  // Note(yoochan.kim): song ids come from the manifest, so the lookup is only
  // as total as the caller's; an unknown one is a bug, not a silent no-op
  private fileOf(song: SongId): string {
    const file = this.playlist[song];
    if (file === undefined) throw new Error(`No audio file for song '${song}'`);
    return file;
  }

  /**
   * Whether the file on the deck has run out.
   *
   * Note(yoochan.kim): asked of mpv rather than worked out from a duration and a clock.
   * A track can be paused part-way, and a timer started when it began would go
   * off while it sat there stopped.
   */
  hasEnded(): boolean {
    try {
      return this.mpv.getProperty("eof-reached") === "yes";
    } catch (error) {
      log.error('audioDevice', null, 'Failed to read eof-reached', { error: errorMessage(error) });
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

  /**
   * Initializes the device with default settings and loads the initial song.
   */
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

  /**
   * Creates a delay for smooth transitions
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Gets current playback time, or null if it can't be read.
   * Returning null (rather than 0) lets callers keep the previously saved
   * position instead of clobbering it with a bogus value.
   */
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

  /**
   * Pauses playback, fading out unless told otherwise. See `resume` for when a
   * fade is wanted and when it is only a delay.
   */
  async pause(fade = true): Promise<void> {
    const currentVolume = parseFloat(this.mpv.getProperty("volume") ?? '');
    if (!fade) {
      this.mpv.setProperty("pause", "yes");
      return;
    }
    const { FADE_STEPS, FADE_STEP_MS } = DEVICE_CONFIG;
    for (let i = 0; i <= FADE_STEPS; ++i) {
      const t = i / FADE_STEPS;
      const volume = currentVolume * Math.cos((Math.PI / 2) * t);
      this.mpv.setProperty("volume", volume.toString());
      await this.delay(FADE_STEP_MS);
    }
    this.mpv.setProperty("pause", "yes");
    this.mpv.setProperty("volume", currentVolume.toString());
  }

  /**
   * Resumes playback, fading in unless told otherwise.
   *
   * A fade covers a cut: sound appearing part-way through a piece, or leaving
   * before it is over. A song that begins at its own beginning has nothing to
   * cover, and fading it in only mutes the opening the arranger wrote.
   */
  async resume(fade = true): Promise<void> {
    const currentVolume = parseFloat(this.mpv.getProperty("volume") ?? '');
    if (!fade) {
      this.mpv.setProperty("pause", "no");
      return;
    }
    this.mpv.setProperty("volume", "0");
    this.mpv.setProperty("pause", "no");
    const { FADE_STEPS, FADE_STEP_MS } = DEVICE_CONFIG;
    for (let i = 0; i <= FADE_STEPS; ++i) {
      const t = i / FADE_STEPS;
      const volume = currentVolume * Math.sin((Math.PI / 2) * t);
      this.mpv.setProperty("volume", volume.toString());
      await this.delay(FADE_STEP_MS);
    }
  }

  /**
   * Sets the volume level
   * @param volume - Volume level (0-100)
   */
  setVolume(volume: number): void {
    this.mpv.setProperty("volume", volume.toString());
  }

  /**
   * Saves a song's live playback position into its time memory — keeps the
   * existing saved value if the position can't be read.
   */
  captureSongTime(song: SongId): void {
    const currentTime = this.getCurrentSongTime();
    if (currentTime !== null) {
      this.currentSongTimes[song] = currentTime;
    }
  }

  /**
   * Loads a song onto the two-song deck. The deck loops forever (a scheduled
   * track may have switched looping off, so it is restored here). Position
   * saving is the caller's decision via captureSongTime().
   */
  loadSong(song: SongId): void {
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

  /**
   * Sets the playback position with retry + tolerance verification: the
   * read-back can be off by a frame/block, and right after a track switch it
   * may be null (NaN) — both must retry, never pass as success.
   */
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

  /**
   * Loads the saved playback time for a song
   */
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

  /**
   * Plays an arbitrary library file from an offset (scheduled flows): loads it
   * paused, seeks, and starts. It fades in only when the offset put it past the
   * opening — a song beginning at its beginning has no cut to cover.
   *
   * A flow's track runs once and ends on time; an admin may ask for one to
   * repeat, so looping is the caller's to say. changeSong() restores it either
   * way for the two-song deck.
   */
  async playFileAt(filePath: string, offsetSec: number, loop = false): Promise<void> {
    this.mpv.setProperty("pause", "yes");
    this.mpv.setProperty("loop", loop ? "inf" : "no");

    try {
      this.mpv.executeCommand(["loadfile", filePath, null]);
    } catch (error) {
      log.error('audioDevice', null, 'Failed to load track file', { filePath, error: errorMessage(error) });
      throw error;
    }

    if (offsetSec > 0) {
      try {
        await this.setPlaybackTime(offsetSec);
      } catch (error) {
        log.error('audioDevice', null, 'Failed to seek track', { filePath, offsetSec, error: errorMessage(error) });
        throw error;
      }
    }

    // Note(yoochan.kim): a seek means the run joined this song part-way through, so
    // the fade covers a cut. From the top there is no cut to cover.
    await this.resume(offsetSec > 0);
  }
}

export default AudioDevice;
