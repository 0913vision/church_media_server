import { SOCKET_EVENTS, PLAYER_STATE } from '../constants/socketConfig.js';
import { log } from '../utils/logger.js';

/**
 * Registers state-related socket event handlers (play/pause/lock)
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} deps - Shared dependencies (see handlers/index.js)
 */
export const registerStateHandlers = (socket, deps) => {
  const { io, player, lockCoordinator } = deps;
  /**
   * Handle state get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_STATE_EVENT, async () => {
    try {
      socket.emit(SOCKET_EVENTS.S2C_STATE_CHANGED_EVENT, player.getState());
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
      socket.emit(SOCKET_EVENTS.S2C_LOCK_CHANGED_EVENT, audio);
      socket.emit(SOCKET_EVENTS.S2C_ADMIN_LOCK_CHANGED_EVENT, admin);
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

      const lockAcquired = await lockCoordinator.withAudioLock(socket, async () => {
        if (newState === PLAYER_STATE.PLAYING) {
          await player.play();
        } else {
          await player.pause();
        }

        io.emit(SOCKET_EVENTS.S2C_STATE_CHANGED_EVENT, newState);
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
