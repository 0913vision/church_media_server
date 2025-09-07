/**
 * Mock console implementation for development/testing
 */
class MockConsole {
  constructor() {
    console.log("[MockConsole] Mock console initialized");
  }

  /**
   * Creates a delay for consistent API behavior
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise<void>}
   * @private
   */
  #delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Mock pastor microphone enable operation
   * @returns {Promise<void>}
   */
  async enablePastorMic() {
    console.log("[MockConsole] Enabling pastor microphone");
    console.log("[MockConsole] → Channel 01: mix/on = 1, fader = 0.687");
    console.log("[MockConsole] → Channel 02: mix/on = 1, fader = 0.837");
    await this.#delay(50);
    console.log("[MockConsole] Pastor microphone enabled");
  }

  /**
   * Mock auxiliary input enable operation
   * @returns {Promise<void>}
   */
  async enableAux() {
    console.log("[MockConsole] Enabling auxiliary input");
    console.log("[MockConsole] → AuxIn 05: mix/on = 1, fader = 0.75");
    await this.#delay(50);
    console.log("[MockConsole] Auxiliary input enabled");
  }
}

export default MockConsole;