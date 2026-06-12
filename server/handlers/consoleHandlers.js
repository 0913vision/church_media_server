import { SOCKET_EVENTS } from '../constants/socketConfig.js';
import { log } from '../utils/logger.js';

/**
 * Registers console-related socket event handlers (mixer controls).
 *
 * Console operations take NO resource lock — the console holds no protected
 * state and its OSC bursts are instantaneous. They are only gated by the admin
 * lock (handled inside withAdminGate).
 *
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} deps - Shared dependencies (see handlers/index.js)
 */
export const registerConsoleHandlers = (socket, deps) => {
  const { lockCoordinator, consoleHandler } = deps;
  /**
   * Handle microphone on request
   */
  socket.on(SOCKET_EVENTS.C2S_MIC_ON_EVENT, async () => {
    try {
      const allowed = await lockCoordinator.withAdminGate(socket, async () => {
        await consoleHandler.enablePastorMic();
      });

      if (!allowed) {
        log.warn('consoleHandler', socket, 'Mic on blocked (admin lock)');
        return;
      }
    } catch (error) {
      log.error('consoleHandler', socket, 'Error enabling pastor microphone', { error: error.message });
    }
  });

  /**
   * Handle auxiliary input on request
   */
  socket.on(SOCKET_EVENTS.C2S_AUX_ON_EVENT, async () => {
    try {
      const allowed = await lockCoordinator.withAdminGate(socket, async () => {
        await consoleHandler.enableAux();
      });

      if (!allowed) {
        log.warn('consoleHandler', socket, 'Aux on blocked (admin lock)');
        return;
      }
    } catch (error) {
      log.error('consoleHandler', socket, 'Error enabling auxiliary input', { error: error.message });
    }
  });
};
