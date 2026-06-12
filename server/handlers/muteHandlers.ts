import type { ServerSocket } from '../constants/socketConfig.ts';
import { SOCKET_EVENTS } from '../constants/socketConfig.ts';
import { isMuteState } from '../constants/playerStates.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';
import type { HandlerDeps } from './index.ts';

/**
 * Registers mute-related socket event handlers
 */
export const registerMuteHandlers = (socket: ServerSocket, deps: HandlerDeps): void => {
  const { notifier, player, lockCoordinator, adminSessionManager } = deps;

  /**
   * Handle mute status get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_MUTE_EVENT, async () => {
    try {
      notifier.muteChanged(player.getMute(), socket);
    } catch (error) {
      log.error('muteHandler', socket, 'Error getting mute status', { error: errorMessage(error) });
    }
  });

  /**
   * Handle mute change request (audio resource operation)
   */
  socket.on(SOCKET_EVENTS.C2S_CHANGE_MUTE_EVENT, async (newMute: unknown) => {
    try {
      if (!isMuteState(newMute)) {
        log.warn('muteHandler', socket, 'Invalid mute state requested, request denied', { newMute });
        return;
      }

      const isAdmin = adminSessionManager.isAdminSocket(socket);
      const lockAcquired = await lockCoordinator.withAudioLock(isAdmin, async () => {
        player.setMute(newMute);
        notifier.muteChanged(newMute);
      });

      if (!lockAcquired) {
        log.warn('muteHandler', socket, 'Mute change blocked (admin lock or audio busy)');
        return;
      }
    } catch (error) {
      log.error('muteHandler', socket, 'Error changing mute status', { error: errorMessage(error), newMute });
    }
  });
};
