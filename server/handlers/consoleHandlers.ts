import type { ServerSocket } from '../constants/socketConfig.ts';
import { SOCKET_EVENTS } from '../constants/socketConfig.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';
import type { HandlerDeps } from './index.ts';

/**
 * Registers console-related socket event handlers (mixer controls).
 *
 * Console operations take NO resource lock — the console holds no protected
 * state and its OSC bursts are instantaneous. They are only gated by the admin
 * lock (handled inside withAdminGate).
 */
export const registerConsoleHandlers = (socket: ServerSocket, deps: HandlerDeps): void => {
  const { lockCoordinator, mixerConsole, adminSessionManager } = deps;

  /**
   * Handle microphone on request
   */
  socket.on(SOCKET_EVENTS.C2S_MIC_ON_EVENT, async () => {
    try {
      const isAdmin = adminSessionManager.isAdminSocket(socket);
      const allowed = await lockCoordinator.withAdminGate(isAdmin, async () => {
        await mixerConsole.enablePastorMic();
      });

      if (!allowed) {
        log.warn('consoleHandler', socket, 'Mic on blocked (admin lock)');
        return;
      }
    } catch (error) {
      log.error('consoleHandler', socket, 'Error enabling pastor microphone', { error: errorMessage(error) });
    }
  });

  /**
   * Handle auxiliary input on request
   */
  socket.on(SOCKET_EVENTS.C2S_AUX_ON_EVENT, async () => {
    try {
      const isAdmin = adminSessionManager.isAdminSocket(socket);
      const allowed = await lockCoordinator.withAdminGate(isAdmin, async () => {
        await mixerConsole.enableAux();
      });

      if (!allowed) {
        log.warn('consoleHandler', socket, 'Aux on blocked (admin lock)');
        return;
      }
    } catch (error) {
      log.error('consoleHandler', socket, 'Error enabling auxiliary input', { error: errorMessage(error) });
    }
  });
};
