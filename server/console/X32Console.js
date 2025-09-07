import osc from 'osc';
const { UDPPort } = osc;
import { CONSOLE_CONFIG } from '../constants/consoleConfig.js';

/**
 * X32 console implementation for actual hardware communication
 */
class X32Console {
  #client;

  constructor() {
    this.#client = new UDPPort({
      localAddress: CONSOLE_CONFIG.NETWORK.LOCAL_ADDRESS,
      localPort: CONSOLE_CONFIG.NETWORK.LOCAL_PORT,
      remoteAddress: CONSOLE_CONFIG.NETWORK.REMOTE_ADDRESS,
      remotePort: CONSOLE_CONFIG.NETWORK.REMOTE_PORT
    });
    
    this.#initialize();
  }

  /**
   * Initialize the X32 client connection
   * @private
   */
  #initialize() {
    this.#client.open();
    this.#client.on("ready", () => {
      console.log("X32 console client is ready");
    });
  }

  /**
   * Send OSC command to X32 console
   * @param {string} address - OSC address
   * @param {*} args - OSC arguments
   * @returns {Promise<void>}
   * @private
   */
  #sendOscCommand(address, args) {
    return new Promise((resolve) => {
      this.#client.send({
        address: address,
        args: args
      });
      resolve();
    });
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
   * Turn on pastor microphone channels
   * @returns {Promise<void>}
   */
  async enablePastorMic() {
    const { CH1, CH2 } = CONSOLE_CONFIG.PASTOR_MIC.CHANNELS;
    const { UNMUTE } = CONSOLE_CONFIG.OSC_VALUES;

    await this.#sendOscCommand(CH1.MUTE_ADDRESS, UNMUTE);
    await this.#sendOscCommand(CH2.MUTE_ADDRESS, UNMUTE);
    await this.#sendOscCommand(CH1.FADER_LEVEL_ADDRESS, CH1.FADER_LEVEL);
    await this.#sendOscCommand(CH2.FADER_LEVEL_ADDRESS, CH2.FADER_LEVEL);
  }

  /**
   * Turn on auxiliary input
   * @returns {Promise<void>}
   */
  async enableAux() {
    const { MUTE_ADDRESS, FADER_LEVEL_ADDRESS, FADER_LEVEL } = CONSOLE_CONFIG.AUX_INPUT;
    const { UNMUTE } = CONSOLE_CONFIG.OSC_VALUES;

    await this.#sendOscCommand(MUTE_ADDRESS, UNMUTE);
    await this.#sendOscCommand(FADER_LEVEL_ADDRESS, FADER_LEVEL);
  }
}

export default X32Console;