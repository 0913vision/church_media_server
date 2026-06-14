import ffi from 'ffi-napi';
import array from 'ref-array-napi';
import { DEVICE_CONFIG } from '../constants/deviceConfig.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

/**
 * Opaque libmpv handle (a pointer on the FFI side). Branded so arbitrary
 * values cannot be passed where a handle is expected — only values produced
 * by mpv_create satisfy this type.
 */
declare const MpvHandleBrand: unique symbol;
type MpvHandle = { readonly [MpvHandleBrand]: never };

/** The libmpv surface this project binds */
interface MpvApi {
  mpv_create(): MpvHandle;
  mpv_initialize(handle: MpvHandle): number;
  mpv_command(handle: MpvHandle, command: (string | null)[]): number;
  mpv_set_property_string(handle: MpvHandle, property: string, value: string): number;
  mpv_get_property_string(handle: MpvHandle, property: string): string | null;
}

/**
 * Low-level MPV FFI wrapper that handles direct library bindings
 */
class MpvClient {
  private api!: MpvApi;
  private playerInstance!: MpvHandle;

  /**
   * Creates a new MpvClient instance and initializes MPV
   */
  constructor() {
    this.initializeFFI();
  }

  /**
   * Initializes MPV FFI library bindings
   */
  private initializeFFI(): void {
    const StringArray = array('string');
    const libmpvPath = DEVICE_CONFIG.MPV_LIBRARY_PATH;

    try {
      this.api = ffi.Library(libmpvPath, {
        'mpv_create': ['pointer', []],
        'mpv_initialize': ['int', ['pointer']],
        'mpv_command': ['int', ['pointer', StringArray]],
        'mpv_set_property_string': ['int', ['pointer', 'string', 'string']],
        'mpv_get_property_string': ['string', ['pointer', 'string']]
      }) as MpvApi;
    } catch (error) {
      log.error('mpvClient', null, 'Failed to load MPV library', { libmpvPath, error: errorMessage(error) });
      throw error;
    }

    try {
      this.playerInstance = this.api.mpv_create();
    } catch (error) {
      log.error('mpvClient', null, 'Failed to create MPV instance', { error: errorMessage(error) });
      throw error;
    }

    try {
      const result = this.api.mpv_initialize(this.playerInstance);
      if (result !== 0) {
        throw new Error(`MPV initialization failed with code: ${result}`);
      }
    } catch (error) {
      log.error('mpvClient', null, 'Failed to initialize MPV', { error: errorMessage(error) });
      throw error;
    }
  }

  /**
   * Sets a property on the MPV player instance. libmpv returns a negative
   * code on failure; surface it instead of failing silently.
   */
  setProperty(property: string, value: string): void {
    const code = this.api.mpv_set_property_string(this.playerInstance, property, value);
    if (code < 0) {
      log.warn('mpvClient', null, 'mpv_set_property_string failed', { property, value, code });
    }
  }

  /**
   * Gets a property from the MPV player instance
   */
  getProperty(property: string): string | null {
    return this.api.mpv_get_property_string(this.playerInstance, property);
  }

  /**
   * Executes a command on the MPV player instance. libmpv returns a negative
   * code on failure; surface it instead of failing silently.
   */
  executeCommand(command: (string | null)[]): void {
    const code = this.api.mpv_command(this.playerInstance, command);
    if (code < 0) {
      log.warn('mpvClient', null, 'mpv_command failed', { command: command.join(' '), code });
    }
  }
}

export default MpvClient;
