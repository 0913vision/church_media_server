import MPVHandler from '@/hardware/MPVHandler';
import { DEVICE_CONFIG } from '@/constants/deviceConfig';

/**
 * High-level device controller that manages audio playback operations
 */
class DeviceHandler {
  #mpv;
  #playlist;
  #currentSongTimes;

  /**
   * Creates a new DeviceHandler instance
   */
  constructor() {
    this.#mpv = new MPVHandler();
    this.#playlist = [...DEVICE_CONFIG.PLAYLIST];
    this.#currentSongTimes = {...DEVICE_CONFIG.INITIAL_SONG_TIMES};
    this.#initialize();
  }

  /**
   * Initializes the device with default settings
   * @private
   */
  #initialize() {
    this.#mpv.setProperty("loop", "inf");
    this.#mpv.executeCommand(["loadfile", this.#playlist[0], null]);
    this.#mpv.setProperty("pause", "yes");
  }

  /**
   * Creates a delay for smooth transitions
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise<void>}
   * @private
   */
  #delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Gets current playback time
   * @returns {number} Current playback time in seconds
   * @private
   */
  #getCurrentSongTime() {
    const response = this.#mpv.getProperty("playback-time");
    return parseFloat(response);
  }

  /**
   * Pauses playback with fade out effect
   * @returns {Promise<void>}
   */
  async pause() {
    const currentVolume = parseFloat(this.#mpv.getProperty("volume"));
    for (let i = 0; i <= 30; ++i) {
      const t = i / 30;
      const volume = currentVolume * Math.cos((Math.PI / 2) * t);
      this.#mpv.setProperty("volume", volume.toString());
      await this.#delay(100);
    }
    this.#mpv.setProperty("pause", "yes");
    this.#mpv.setProperty("volume", currentVolume.toString());
  }

  /**
   * Resumes playback with fade in effect
   * @returns {Promise<void>}
   */
  async resume() {
    const currentVolume = parseFloat(this.#mpv.getProperty("volume"));
    this.#mpv.setProperty("volume", "0");
    this.#mpv.setProperty("pause", "no");
    for (let i = 0; i <= 30; ++i) {
      const t = i / 30;
      const volume = currentVolume * Math.sin((Math.PI / 2) * t);
      this.#mpv.setProperty("volume", volume.toString());
      await this.#delay(100);
    }
  }

  /**
   * Sets the volume level
   * @param {number} volume - Volume level (0-100)
   */
  setVolume(volume) {
    this.#mpv.setOption("volume", volume.toString());
  }

  /**
   * Changes the current song
   * @param {string} currentSong - Current song type
   * @param {string} newSong - New song type
   */
  changeSong(currentSong, newSong) {
    // Save current song time
    const currentTime = this.#getCurrentSongTime();
    this.#currentSongTimes[currentSong] = currentTime;

    // Switch track
    const trackIndex = newSong === "slow" ? 0 : 1;
    const nextCommand = ["loadfile", this.#playlist[trackIndex], null];
    this.#mpv.executeCommand(nextCommand);
  }

  /**
   * Loads the saved playback time for a song
   * @param {string} song - Song type
   */
  loadLastSongTime(song) {
    do {
      this.#mpv.setProperty("playback-time", this.#currentSongTimes[song].toString());
    } while (parseFloat(this.#mpv.getProperty("playback-time")) !== this.#currentSongTimes[song]);
  }
}

export default DeviceHandler;