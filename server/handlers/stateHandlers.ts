import type { ServerSocket } from '../constants/socketConfig.ts';
import { SOCKET_EVENTS } from '../constants/socketConfig.ts';
import { PlayerState, isPlayerState } from '../constants/playerStates.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';
import type { HandlerDeps } from './index.ts';

/**
 * Registers state-related socket event handlers (play/pause/lock)
 */
export const registerStateHandlers = (socket: ServerSocket, deps: HandlerDeps): void => {
  const { notifier, player, lockCoordinator, adminSessionManager } = deps;

  /**
   * Handle state get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_STATE_EVENT, async () => {
    try {
      notifier.stateChanged(player.getState(), socket);
    } catch (error) {
      log.error('stateHandler', socket, 'Error getting state', { error: errorMessage(error) });
    }
  });

  /**
   * Handle lock get request — reports both lock states on their own events
   */
  socket.on(SOCKET_EVENTS.C2S_GET_LOCK_EVENT, async () => {
    try {
      const { audio, admin } = lockCoordinator.getLockState();
      notifier.audioLockChanged(audio, socket);
      notifier.adminLockChanged(admin, socket);
    } catch (error) {
      log.error('stateHandler', socket, 'Error getting lock', { error: errorMessage(error) });
    }
  });

  /**
   * Handle state change request (play/pause) — audio resource operation
   */
  socket.on(SOCKET_EVENTS.C2S_CHANGE_STATE_EVENT, async (newState: unknown) => {
    try {
      if (!isPlayerState(newState)) {
        log.warn('stateHandler', socket, 'Invalid state requested, request denied', { newState });
        return;
      }
      if (newState === player.getState()) return;

      const isAdmin = adminSessionManager.isAdminSocket(socket);
      const lockAcquired = await lockCoordinator.withAudioLock(isAdmin, async () => {
        if (newState === PlayerState.PLAYING) {
          await player.play();
        } else {
          await player.pause();
        }

        notifier.stateChanged(newState);
      });

      if (!lockAcquired) {
        log.warn('stateHandler', socket, 'State change blocked (admin lock or audio busy)');
        return;
      }
    } catch (error) {
      log.error('stateHandler', socket, 'Error changing state', { error: errorMessage(error), newState });
    }
  });
};
