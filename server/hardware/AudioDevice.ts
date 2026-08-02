import MpvClient from './MpvClient.ts';
import { DEVICE_CONFIG } from '../constants/deviceConfig.ts';
import { SongType } from '../constants/songs.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';
import type { AudioOutput } from './AudioOutput.ts';

/**
 * High-level device controller that manages audio playback operations
 */
class AudioDevice implements AudioOutput {
  private readonly playlist: Record<SongType, string>;
  private readonly currentSongTimes: Record<SongType, number>;

  /**
   * @param mpv - Low-level MPV client (injected by the composition root)
   * @param initialSong - Song to load on startup (the player's initial current
   *   song, injected so this layer isn't coupled to player defaults)
   */
  constructor(private readonly mpv: MpvClient, private readonly initialSong: SongType) {
    this.playlist = { ...DEVICE_CONFIG.PLAYLIST };
    this.currentSongTimes = { ...DEVICE_CONFIG.INITIAL_SONG_TIMES };
    this.initialize();
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
      this.mpv.executeCommand(["loadfile", this.playlist[this.initialSong], null]);
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
   * Pauses playback with fade out effect
   */
  async pause(): Promise<void> {
    const currentVolume = parseFloat(this.mpv.getProperty("volume") ?? '');
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
   * Resumes playback with fade in effect
   */
  async resume(): Promise<void> {
    const currentVolume = parseFloat(this.mpv.getProperty("volume") ?? '');
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
  captureSongTime(song: SongType): void {
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
  loadSong(song: SongType): void {
    this.mpv.setProperty("loop", "inf");

    try {
      this.mpv.executeCommand(["loadfile", this.playlist[song], null]);
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
  async loadLastSongTime(song: SongType): Promise<void> {
    const targetTime = this.currentSongTimes[song];
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
   * Plays an arbitrary library file from an offset (scheduled flows): loads
   * it paused, seeks, then fades in. Looping is disabled so the track ends
   * naturally; changeSong() restores it for the two-song system.
   */
  async playFileAt(filePath: string, offsetSec: number): Promise<void> {
    this.mpv.setProperty("pause", "yes");
    this.mpv.setProperty("loop", "no");

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

    await this.resume();
  }
}

export default AudioDevice;
