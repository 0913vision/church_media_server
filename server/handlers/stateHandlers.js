import { SOCKET_EVENTS, PLAYER_STATE } from '../constants/socketConfig.js';
import { log } from '../utils/logger.js';

/**
 * Registers state-related socket event handlers (play/pause/lock)
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} io - Socket.IO server instance
 * @param {Player} player - Player instance
 * @param {LockCoordinator} lockCoordinator - Lock coordinator instance
 */
export const registerStateHandlers = (socket, io, player, lockCoordinator) => {
  /**
   * Handle state get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_STATE_EVENT, async () => {
    try {
      const currentState = !lockCoordinator.isAdminOperationActive() 
        ? player.getState() 
        : lockCoordinator.getSavedUserState()?.state;
      socket.emit(SOCKET_EVENTS.S2C_STATE_CHANGED_EVENT, currentState);
    } catch (error) {
      log.error('stateHandler', socket, 'Error getting state', { error: error.message });
    }
  });

  /**
   * Handle lock get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_LOCK_EVENT, async () => {
    try {
      const lockStatus = lockCoordinator.isLocked();
      socket.emit(SOCKET_EVENTS.S2C_LOCK_CHANGED_EVENT, lockStatus);
    } catch (error) {
      log.error('stateHandler', socket, 'Error getting lock', { error: error.message });
    }
  });

  /**
   * Handle state change request (play/pause)
   */
  socket.on(SOCKET_EVENTS.C2S_CHANGE_STATE_EVENT, async (newState) => {
    try {
      if (newState === player.getState()) return;

      const lockAcquired = await lockCoordinator.withUserLock(async () => {
        if (newState === PLAYER_STATE.PLAYING) {
          await player.play();
        } else {
          await player.pause();
        }

        io.emit(SOCKET_EVENTS.S2C_STATE_CHANGED_EVENT, newState);
      });

      if (!lockAcquired) {
        log.warn('stateHandler', socket, 'Lock acquisition failed for state change, request denied');
        return;
      }
    } catch (error) {
      log.error('stateHandler', socket, 'Error changing state', { error: error.message, newState });
    }
  });
};