import ffi from 'ffi-napi';
import ref from 'ref-napi';
import array from 'ref-array-napi';
import Struct from 'ref-struct-di';
import { DEVICE_CONFIG } from '../constants/deviceConfig.js';
import { log } from '../utils/logger.js';

/**
 * Low-level MPV FFI wrapper that handles direct library bindings
 */
class MPVHandler {
  #api;
  #playerInstance;

  /**
   * Creates a new MPVHandler instance and initializes MPV
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

    const StructType = Struct(ref);
    const mpv_event = StructType({
      event_id: 'int',
      error: 'int',
      reply_userdata: 'uint64',
      data: 'pointer'
    });

    try {
      this.#api = ffi.Library(libmpvPath, {
        'mpv_create': ['pointer', []],
        'mpv_initialize': ['int', ['pointer']],
        'mpv_command': ['int', ['pointer', StringArray]],
        'mpv_set_option_string': ['int', ['pointer', 'string', 'string']],
        'mpv_set_property_string': ['int', ['pointer', 'string', 'string']],
        'mpv_get_property_string': ['string', ['pointer', 'string']],
        'mpv_command_async': ['int', ['pointer', 'uint64', StringArray]],
        'mpv_wait_event': [mpv_event, ['pointer', 'double']]
      });
    } catch (error) {
      log.error('mpvHandler', null, 'Failed to load MPV library', { libmpvPath, error: error.message });
      throw error;
    }

    try {
      this.#playerInstance = this.#api.mpv_create();
    } catch (error) {
      log.error('mpvHandler', null, 'Failed to create MPV instance', { error: error.message });
      throw error;
    }

    try {
      const result = this.#api.mpv_initialize(this.#playerInstance);
      if (result !== 0) {
        throw new Error(`MPV initialization failed with code: ${result}`);
      }
    } catch (error) {
      log.error('mpvHandler', null, 'Failed to initialize MPV', { error: error.message });
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

  /**
   * Sets an option on the MPV player instance
   * @param {string} option - Option name
   * @param {string} value - Option value
   */
  setOption(option, value) {
    this.#api.mpv_set_option_string(this.#playerInstance, option, value);
  }
}

export default MPVHandler;