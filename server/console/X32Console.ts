import osc from 'osc';
import { CONSOLE_CONFIG } from '../constants/consoleConfig.ts';
import { log } from '../utils/logger.ts';
import type { ConsoleDevice } from './ConsoleDevice.ts';

const { UDPPort } = osc;

/**
 * X32 console implementation for actual hardware communication
 */
class X32Console implements ConsoleDevice {
  private readonly client: InstanceType<typeof UDPPort>;

  constructor() {
    this.client = new UDPPort({
      localAddress: CONSOLE_CONFIG.NETWORK.LOCAL_ADDRESS,
      localPort: CONSOLE_CONFIG.NETWORK.LOCAL_PORT,
      remoteAddress: CONSOLE_CONFIG.NETWORK.REMOTE_ADDRESS,
      remotePort: CONSOLE_CONFIG.NETWORK.REMOTE_PORT
    });

    this.initialize();
  }

  /**
   * Initialize the X32 client connection
   */
  private initialize(): void {
    this.client.open();
    this.client.on("ready", () => {
      log.info('x32Console', null, 'X32 console client is ready');
    });
  }

  /**
   * Send OSC command to X32 console — every value this project sends
   * (mute on/off, fader levels) is a number
   */
  private sendOscCommand(address: string, args: number): Promise<void> {
    return new Promise((resolve) => {
      this.client.send({
        address: address,
        args: args
      });
      resolve();
    });
  }

  /**
   * Turn on pastor microphone channels
   */
  async enablePastorMic(): Promise<void> {
    const { CH1, CH2 } = CONSOLE_CONFIG.PASTOR_MIC.CHANNELS;
    const { UNMUTE } = CONSOLE_CONFIG.OSC_VALUES;

    await this.sendOscCommand(CH1.MUTE_ADDRESS, UNMUTE);
    await this.sendOscCommand(CH2.MUTE_ADDRESS, UNMUTE);
    await this.sendOscCommand(CH1.FADER_LEVEL_ADDRESS, CH1.FADER_LEVEL);
    await this.sendOscCommand(CH2.FADER_LEVEL_ADDRESS, CH2.FADER_LEVEL);
  }

  /**
   * Turn on auxiliary input
   */
  async enableAux(): Promise<void> {
    const { MUTE_ADDRESS, FADER_LEVEL_ADDRESS, FADER_LEVEL } = CONSOLE_CONFIG.AUX_INPUT;
    const { UNMUTE } = CONSOLE_CONFIG.OSC_VALUES;

    await this.sendOscCommand(MUTE_ADDRESS, UNMUTE);
    await this.sendOscCommand(FADER_LEVEL_ADDRESS, FADER_LEVEL);
  }
}

export default X32Console;
