import { SOCKET_EVENTS } from '../constants/socketConfig.js';
import ConsoleHandler from '../console/ConsoleHandler.js';

/**
 * Registers console-related socket event handlers (mixer controls)
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} io - Socket.IO server instance
 * @param {Player} player - Player instance (not used for console operations)
 */
export const registerConsoleHandlers = (socket, io, player) => {
  const consoleHandler = new ConsoleHandler();

  /**
   * Handle microphone on request
   */
  socket.on(SOCKET_EVENTS.C2S_MIC_ON_EVENT, async () => {
    try {
      await consoleHandler.enablePastorMic();
    } catch (error) {
      console.error('Error enabling pastor microphone:', error);
    }
  });

  /**
   * Handle auxiliary input on request
   */
  socket.on(SOCKET_EVENTS.C2S_AUX_ON_EVENT, async () => {
    try {
      await consoleHandler.enableAux();
    } catch (error) {
      console.error('Error enabling auxiliary input:', error);
    }
  });
};