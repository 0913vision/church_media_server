import { PlayerState, MuteState, SongType } from '../constants/playerStates.ts';
import { INITIAL_PLAYER_CONFIG, DEFAULT_SONG_VOLUMES } from '../constants/playerConfig.ts';
import type { PlayerConfig } from '../constants/playerConfig.ts';
import type { AudioOutput } from '../hardware/AudioOutput.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

/**
 * High-level Player class that abstracts hardware control and manages player state
 */
class Player {
  private state: PlayerConfig;

  /**
   * @param device - Audio output (injected by the composition root)
   */
  constructor(private readonly device: AudioOutput) {
    this.state = { ...INITIAL_PLAYER_CONFIG };
    // Initialize hardware with default volume
    this.device.setVolume(this.state.serverVolume);
  }

  // Volume methods
  /**
   * Gets the current volume level
   * @returns Current volume (0-100)
   */
  getVolume(): number {
    return this.state.serverVolume;
  }

  /**
   * Sets the volume level and updates hardware.
   * While muted, the device stays silent — only the remembered volume changes.
   * @param volume - Volume level (0-100)
   */
  setVolume(volume: number): void {
    this.state.serverVolume = volume;
    this.device.setVolume(this.isMuted() ? 0 : volume);
  }

  // State methods
  /**
   * Gets the current playback state
   */
  getState(): PlayerState {
    return this.state.state;
  }

  /**
   * Plays the audio and updates state
   */
  async play(): Promise<void> {
    try {
      await this.device.resume();
    } catch (error) {
      log.error('player', null, 'Failed to play audio', { error: errorMessage(error) });
      throw error;
    }
    this.state.state = PlayerState.PLAYING;
  }

  /**
   * Pauses the audio and updates state
   */
  async pause(): Promise<void> {
    try {
      await this.device.pause();
    } catch (error) {
      log.error('player', null, 'Failed to pause audio', { error: errorMessage(error) });
      throw error;
    }
    this.state.state = PlayerState.PAUSED;
  }

  // Mute methods
  /**
   * Gets the current mute status
   */
  getMute(): MuteState {
    return this.state.muted;
  }

  /**
   * Sets mute status and updates hardware volume
   */
  setMute(muted: MuteState): void {
    this.state.muted = muted;
    if (muted === MuteState.MUTED) {
      this.device.setVolume(0);
    } else {
      this.device.setVolume(this.state.serverVolume);
    }
  }

  // Song methods
  /**
   * Gets the currently selected song
   */
  getCurrentSong(): SongType {
    return this.state.currentSong;
  }

  /**
   * Changes song, updates volume, and handles hardware switching.
   * The player's own state decides which song is current; while muted, the
   * device stays silent and only the remembered volume moves to the new
   * song's default.
   * @param newSong - New song type (SongType.SLOW or SongType.FAST)
   */
  async changeSong(newSong: SongType): Promise<void> {
    const currentSong = this.state.currentSong;
    const wasPlaying = this.isPlaying();

    if (wasPlaying) {
      try {
        await this.device.pause();
      } catch (error) {
        log.error('player', null, 'Failed to pause during song change', { error: errorMessage(error) });
        throw error;
      }
    }

    try {
      this.device.changeSong(currentSong, newSong);
    } catch (error) {
      log.error('player', null, 'Failed to change song', { currentSong, newSong, error: errorMessage(error) });
      throw error;
    }

    const newVolume = DEFAULT_SONG_VOLUMES[newSong];

    try {
      this.device.setVolume(this.isMuted() ? 0 : newVolume);
    } catch (error) {
      log.error('player', null, 'Failed to set volume during song change', { newVolume, error: errorMessage(error) });
      throw error;
    }

    this.state.currentSong = newSong;
    this.state.state = PlayerState.PAUSED;
    this.state.serverVolume = newVolume;

    try {
      await this.device.loadLastSongTime(newSong);
    } catch (error) {
      log.error('player', null, 'Failed to load last song time', { newSong, error: errorMessage(error) });
      throw error;
    }
  }

  // Utility methods

  /**
   * Checks if the player is currently playing
   */
  isPlaying(): boolean {
    return this.state.state === PlayerState.PLAYING;
  }

  /**
   * Checks if the player is currently muted
   */
  isMuted(): boolean {
    return this.state.muted === MuteState.MUTED;
  }
}

export default Player;
