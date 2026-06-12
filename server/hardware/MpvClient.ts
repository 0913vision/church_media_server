import ffi from 'ffi-napi';
import array from 'ref-array-napi';
import { DEVICE_CONFIG } from '../constants/deviceConfig.js';
import { log } from '../utils/logger.js';

/**
 * Low-level MPV FFI wrapper that handles direct library bindings
 */
class MpvClient {
  #api;
  #playerInstance;

  /**
   * Creates a new MpvClient instance and initializes MPV
   */
  constructor() {
    this.#initializeFFI();
  }

  /**
   * Initializes MPV FFI library bindings
   * @private
   */
  #initializeFFI() {
    const StringArray = array('string');
    const libmpvPath = DEVICE_CONFIG.MPV_LIBRARY_PATH[DEVICE_CONFIG.CURRENT_PLATFORM];

    try {
      this.#api = ffi.Library(libmpvPath, {
        'mpv_create': ['pointer', []],
        'mpv_initialize': ['int', ['pointer']],
        'mpv_command': ['int', ['pointer', StringArray]],
        'mpv_set_property_string': ['int', ['pointer', 'string', 'string']],
        'mpv_get_property_string': ['string', ['pointer', 'string']]
      });
    } catch (error) {
      log.error('mpvClient', null, 'Failed to load MPV library', { libmpvPath, error: error.message });
      throw error;
    }

    try {
      this.#playerInstance = this.#api.mpv_create();
    } catch (error) {
      log.error('mpvClient', null, 'Failed to create MPV instance', { error: error.message });
      throw error;
    }

    try {
      const result = this.#api.mpv_initialize(this.#playerInstance);
      if (result !== 0) {
        throw new Error(`MPV initialization failed with code: ${result}`);
      }
    } catch (error) {
      log.error('mpvClient', null, 'Failed to initialize MPV', { error: error.message });
      throw error;
    }
  }

  /**
   * Sets a property on the MPV player instance
   * @param {string} property - Property name
   * @param {string} value - Property value
   */
  setProperty(property, value) {
    this.#api.mpv_set_property_string(this.#playerInstance, property, value);
  }

  /**
   * Gets a property from the MPV player instance
   * @param {string} property - Property name
   * @returns {string} Property value
   */
  getProperty(property) {
    return this.#api.mpv_get_property_string(this.#playerInstance, property);
  }

  /**
   * Executes a command on the MPV player instance
   * @param {Array<string>} command - Command array
   */
  executeCommand(command) {
    this.#api.mpv_command(this.#playerInstance, command);
  }
}

export default MpvClient;