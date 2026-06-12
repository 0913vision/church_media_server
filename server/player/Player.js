import { PLAYER_STATE, MUTE_STATE } from '../constants/playerStates.js';
import { INITIAL_PLAYER_CONFIG, DEFAULT_SONG_VOLUMES } from '../constants/playerConfig.js';
import AudioDevice from '../hardware/AudioDevice.js';
import { log } from '../utils/logger.js';

/**
 * High-level Player class that abstracts hardware control and manages player state
 */
class Player {
  // Private fields
  #state;
  #device;

  /**
   * Creates a new Player instance with initial configuration
   */
  constructor() {
    this.#state = { ...INITIAL_PLAYER_CONFIG };
    this.#device = new AudioDevice();
    // Initialize hardware with default volume
    this.#device.setVolume(this.#state.serverVolume);
  }

  // Volume methods
  /**
   * Gets the current volume level
   * @returns {number} Current volume (0-100)
   */
  getVolume() {
    return this.#state.serverVolume;
  }

  /**
   * Sets the volume level and updates hardware.
   * While muted, the device stays silent — only the remembered volume changes.
   * @param {number} volume - Volume level (0-100)
   */
  setVolume(volume) {
    this.#state.serverVolume = volume;
    this.#device.setVolume(this.isMuted() ? 0 : volume);
  }

  // State methods
  /**
   * Gets the current playback state
   * @returns {number} Current state (PLAYER_STATE.PAUSED or PLAYER_STATE.PLAYING)
   */
  getState() {
    return this.#state.state;
  }

  /**
   * Plays the audio and updates state
   * @returns {Promise<void>}
   */
  async play() {
    try {
      await this.#device.resume();
    } catch (error) {
      log.error('player', null, 'Failed to play audio', { error: error.message });
      throw error;
    }
    this.#state.state = PLAYER_STATE.PLAYING;
  }

  /**
   * Pauses the audio and updates state
   * @returns {Promise<void>}
   */
  async pause() {
    try {
      await this.#device.pause();
    } catch (error) {
      log.error('player', null, 'Failed to pause audio', { error: error.message });
      throw error;
    }
    this.#state.state = PLAYER_STATE.PAUSED;
  }

  // Mute methods
  /**
   * Gets the current mute status
   * @returns {number} Mute status (MUTE_STATE.UNMUTED or MUTE_STATE.MUTED)
   */
  getMute() {
    return this.#state.muted;
  }

  /**
   * Sets mute status and updates hardware volume
   * @param {number} muted - Mute status (MUTE_STATE.UNMUTED or MUTE_STATE.MUTED)
   */
  setMute(muted) {
    this.#state.muted = muted;
    if (muted === MUTE_STATE.MUTED) {
      this.#device.setVolume(0);
    } else {
      this.#device.setVolume(this.#state.serverVolume);
    }
  }

  // Song methods
  /**
   * Gets the currently selected song
   * @returns {string} Current song (SONG_TYPE.SLOW or SONG_TYPE.FAST)
   */
  getCurrentSong() {
    return this.#state.currentSong;
  }

  /**
   * Changes song, updates volume, and handles hardware switching.
   * The player's own state decides which song is current; while muted, the
   * device stays silent and only the remembered volume moves to the new
   * song's default.
   * @param {string} newSong - New song type (SONG_TYPE.SLOW or SONG_TYPE.FAST)
   * @returns {Promise<void>}
   */
  async changeSong(newSong) {
    const currentSong = this.#state.currentSong;
    const wasPlaying = this.isPlaying();

    if (wasPlaying) {
      try {
        await this.#device.pause();
      } catch (error) {
        log.error('player', null, 'Failed to pause during song change', { error: error.message });
        throw error;
      }
    }

    try {
      this.#device.changeSong(currentSong, newSong);
    } catch (error) {
      log.error('player', null, 'Failed to change song', { currentSong, newSong, error: error.message });
      throw error;
    }

    const newVolume = DEFAULT_SONG_VOLUMES[newSong];

    try {
      this.#device.setVolume(this.isMuted() ? 0 : newVolume);
    } catch (error) {
      log.error('player', null, 'Failed to set volume during song change', { newVolume, error: error.message });
      throw error;
    }

    this.#state.currentSong = newSong;
    this.#state.state = PLAYER_STATE.PAUSED;
    this.#state.serverVolume = newVolume;

    try {
      await this.#device.loadLastSongTime(newSong);
    } catch (error) {
      log.error('player', null, 'Failed to load last song time', { newSong, error: error.message });
      throw error;
    }
  }

  // Utility methods

  /**
   * Checks if the player is currently playing
   * @returns {boolean} True if playing, false otherwise
   */
  isPlaying() {
    return this.#state.state === PLAYER_STATE.PLAYING;
  }

  /**
   * Checks if the player is currently paused
   * @returns {boolean} True if paused, false otherwise
   */
  isPaused() {
    return this.#state.state === PLAYER_STATE.PAUSED;
  }

  /**
   * Checks if the player is currently muted
   * @returns {boolean} True if muted, false otherwise
   */
  isMuted() {
    return this.#state.muted === MUTE_STATE.MUTED;
  }

  /**
   * Gets a copy of the full configuration object (for debugging)
   * @returns {Object} Copy of the current configuration
   */
  getFullConfig() {
    return { ...this.#state };
  }
}

export default Player;