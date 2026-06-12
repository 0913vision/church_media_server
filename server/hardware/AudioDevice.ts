import MpvClient from './MpvClient.ts';
import { DEVICE_CONFIG } from '../constants/deviceConfig.ts';
import { SongType } from '../constants/playerStates.ts';
import { log } from '../utils/logger.ts';

/**
 * High-level device controller that manages audio playback operations
 */
class AudioDevice {
  private readonly playlist: Record<SongType, string>;
  private readonly currentSongTimes: Record<SongType, number>;

  /**
   * @param mpv - Low-level MPV client (injected by the composition root)
   */
  constructor(private readonly mpv: MpvClient) {
    this.playlist = { ...DEVICE_CONFIG.PLAYLIST };
    this.currentSongTimes = { ...DEVICE_CONFIG.INITIAL_SONG_TIMES };
    this.initialize();
  }

  /**
   * Initializes the device with default settings.
   * Loads the slow song first — it is the initial current song
   * (INITIAL_PLAYER_CONFIG.currentSong).
   */
  private initialize(): void {
    try {
      this.mpv.setProperty("loop", "inf");
    } catch (error) {
      log.error('audioDevice', null, 'Failed to set loop property', { error: error.message });
    }

    try {
      this.mpv.executeCommand(["loadfile", this.playlist[SongType.SLOW], null]);
    } catch (error) {
      log.error('audioDevice', null, 'Failed to load initial file', { file: this.playlist[SongType.SLOW], error: error.message });
    }

    try {
      this.mpv.setProperty("pause", "yes");
    } catch (error) {
      log.error('audioDevice', null, 'Failed to set pause property', { error: error.message });
    }
  }

  /**
   * Creates a delay for smooth transitions
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Gets current playback time
   */
  private getCurrentSongTime(): number {
    try {
      const response = this.mpv.getProperty("playback-time");
      return parseFloat(response ?? '') || 0;
    } catch (error) {
      log.error('audioDevice', null, 'Failed to get playback time', { error: error.message });
      return 0;
    }
  }

  /**
   * Pauses playback with fade out effect
   */
  async pause(): Promise<void> {
    const currentVolume = parseFloat(this.mpv.getProperty("volume") ?? '');
    for (let i = 0; i <= 30; ++i) {
      const t = i / 30;
      const volume = currentVolume * Math.cos((Math.PI / 2) * t);
      this.mpv.setProperty("volume", volume.toString());
      await this.delay(100);
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
    for (let i = 0; i <= 30; ++i) {
      const t = i / 30;
      const volume = currentVolume * Math.sin((Math.PI / 2) * t);
      this.mpv.setProperty("volume", volume.toString());
      await this.delay(100);
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
   * Changes the current song
   */
  changeSong(currentSong: SongType, newSong: SongType): void {
    // Save current song time
    const currentTime = this.getCurrentSongTime();
    this.currentSongTimes[currentSong] = currentTime;

    // Switch track — file resolved by explicit song mapping
    const nextCommand = ["loadfile", this.playlist[newSong], null];

    try {
      this.mpv.executeCommand(nextCommand);
    } catch (error) {
      log.error('audioDevice', null, 'Failed to change song', {
        currentSong,
        newSong,
        file: this.playlist[newSong],
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Loads the saved playback time for a song
   */
  async loadLastSongTime(song: SongType): Promise<void> {
    const targetTime = this.currentSongTimes[song];
    let attempts = 0;
    let succeeded = false;

    try {
      do {
        this.mpv.setProperty("playback-time", targetTime.toString());
        await this.delay(DEVICE_CONFIG.PROPERTY_SET_RETRY_DELAY_MS);
        attempts++;

        // Tolerance comparison: the read-back can be off by a frame/block, and
        // right after a track switch it may be null (NaN) — both must retry,
        // never pass as success.
        const currentTime = parseFloat(this.mpv.getProperty("playback-time") ?? '');
        succeeded = Math.abs(currentTime - targetTime) <= DEVICE_CONFIG.PLAYBACK_TIME_TOLERANCE_SEC;
      } while (!succeeded && attempts < DEVICE_CONFIG.MAX_PROPERTY_SET_ATTEMPTS);

      if (!succeeded) {
        throw new Error(`Failed to set playback time after ${attempts} attempts`);
      }
    } catch (error) {
      log.error('audioDevice', null, 'Failed to load last song time', {
        song,
        targetTime,
        attempts,
        error: error.message
      });
      throw error;
    }
  }
}

export default AudioDevice;
