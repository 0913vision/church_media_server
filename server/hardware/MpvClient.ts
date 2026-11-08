import ffi from 'ffi-napi';
import array from 'ref-array-napi';
import { DEVICE_CONFIG } from '../constants/deviceConfig.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

/** Branded so only what mpv_create returns can pass as a handle. */
declare const MpvHandleBrand: unique symbol;
type MpvHandle = { readonly [MpvHandleBrand]: never };

interface MpvApi {
  mpv_create(): MpvHandle;
  mpv_initialize(handle: MpvHandle): number;
  mpv_command(handle: MpvHandle, command: (string | null)[]): number;
  mpv_set_property_string(handle: MpvHandle, property: string, value: string): number;
  mpv_get_property_string(handle: MpvHandle, property: string): string | null;
}

class MpvClient {
  private api!: MpvApi;
  private playerInstance!: MpvHandle;

  constructor() {
    this.initializeFFI();
  }

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

  setProperty(property: string, value: string, quiet = false): void {
    const code = this.api.mpv_set_property_string(this.playerInstance, property, value);
    // Note(yoochan.kim): quiet is for retries that expect a miss just after a load; their last failure is logged.
    if (code < 0 && !quiet) {
      log.warn('mpvClient', null, 'mpv_set_property_string failed', { property, value, code });
    }
  }

  getProperty(property: string): string | null {
    return this.api.mpv_get_property_string(this.playerInstance, property);
  }

  executeCommand(command: (string | null)[]): void {
    // Note(yoochan.kim): mpv reads the list up to a null; one sent without it read past its end and froze the server (2026-11-08, on the Pi).
    const terminated = command.at(-1) === null ? command : [...command, null];
    const code = this.api.mpv_command(this.playerInstance, terminated);
    if (code < 0) {
      log.warn('mpvClient', null, 'mpv_command failed', { command: command.join(' '), code });
    }
  }
}

export default MpvClient;
