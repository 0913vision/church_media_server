import { SOCKET_EVENTS, PLAYER_STATE } from '../constants/socketConfig.js';
import { log } from '../utils/logger.js';

/**
 * Registers state-related socket event handlers (play/pause/lock)
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} deps - Shared dependencies (see handlers/index.js)
 */
export const registerStateHandlers = (socket, deps) => {
  const { notifier, player, lockCoordinator, adminSessionManager } = deps;

  /**
   * Handle state get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_STATE_EVENT, async () => {
    try {
      notifier.stateChanged(player.getState(), socket);
    } catch (error) {
      log.error('stateHandler', socket, 'Error getting state', { error: error.message });
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
      log.error('stateHandler', socket, 'Error getting lock', { error: error.message });
    }
  });

  /**
   * Handle state change request (play/pause) — audio resource operation
   */
  socket.on(SOCKET_EVENTS.C2S_CHANGE_STATE_EVENT, async (newState) => {
    try {
      if (newState === player.getState()) return;

      const isAdmin = adminSessionManager.isAdminSocket(socket);
      const lockAcquired = await lockCoordinator.withAudioLock(isAdmin, async () => {
        if (newState === PLAYER_STATE.PLAYING) {
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
      log.error('stateHandler', socket, 'Error changing state', { error: error.message, newState });
    }
  });
};
