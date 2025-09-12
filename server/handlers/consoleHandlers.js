import { SOCKET_EVENTS } from '../constants/socketConfig.js';
import ConsoleHandler from '../console/ConsoleHandler.js';

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
        console.log('Lock acquisition failed for mic on, request denied');
        return;
      }
    } catch (error) {
      console.error('Error enabling pastor microphone:', error);
    }
  });

  socket.on(SOCKET_EVENTS.C2S_AUX_ON_EVENT, async () => {
    try {
      const lockAcquired = await lockCoordinator.withUserLock(async () => {
        await consoleHandler.enableAux();
      });

      if (!lockAcquired) {
        console.log('Lock acquisition failed for aux on, request denied');
        return;
      }
    } catch (error) {
      console.error('Error enabling auxiliary input:', error);
    }
  });
};