import { SOCKET_EVENTS } from '../constants/socketConfig.js';
import ConsoleHandler from '../console/ConsoleHandler.js';
import { log } from '../utils/logger.js';

/**
 * Registers console-related socket event handlers (mixer controls)
 * @param {Object} socket - Socket.IO socket instance
 * @param {LockCoordinator} lockCoordinator - Lock coordinator instance
 */
export const registerConsoleHandlers = (socket, lockCoordinator) => {
  const consoleHandler = new ConsoleHandler();

  /**
   * Handle microphone on request
   */
  socket.on(SOCKET_EVENTS.C2S_MIC_ON_EVENT, async () => {
    try {
      const lockAcquired = await lockCoordinator.withUserLock(async () => {
        await consoleHandler.enablePastorMic();
      });

      if (!lockAcquired) {
        log.warn('consoleHandler', socket, 'Lock acquisition failed for mic on, request denied');
        return;
      }
    } catch (error) {
      log.error('consoleHandler', socket, 'Error enabling pastor microphone', { error: error.message });
    }
  });

  socket.on(SOCKET_EVENTS.C2S_AUX_ON_EVENT, async () => {
    try {
      const lockAcquired = await lockCoordinator.withUserLock(async () => {
        await consoleHandler.enableAux();
      });

      if (!lockAcquired) {
        log.warn('consoleHandler', socket, 'Lock acquisition failed for aux on, request denied');
        return;
      }
    } catch (error) {
      log.error('consoleHandler', socket, 'Error enabling auxiliary input', { error: error.message });
    }
  });
};