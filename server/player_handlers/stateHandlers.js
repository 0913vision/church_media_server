import { SOCKET_EVENTS, PLAYER_STATE } from '@/constants/socketConfig';

/**
 * Registers state-related socket event handlers (play/pause/lock)
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} io - Socket.IO server instance
 * @param {Player} player - Player instance
 * @param {NetworkLockManager} lockManager - Network lock manager instance
 */
export const registerStateHandlers = (socket, io, player, lockManager) => {
  /**
   * Handle state get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_STATE_EVENT, async () => {
    try {
      const currentState = player.getState();
      socket.emit(SOCKET_EVENTS.S2C_STATE_CHANGED_EVENT, currentState);
    } catch (error) {
      console.error('Error getting state:', error);
    }
  });

  /**
   * Handle lock get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_LOCK_EVENT, async () => {
    try {
      const lockStatus = lockManager.isLocked();
      socket.emit(SOCKET_EVENTS.S2C_LOCK_CHANGED_EVENT, lockStatus);
    } catch (error) {
      console.error('Error getting lock:', error);
    }
  });

  /**
   * Handle state change request (play/pause)
   */
  socket.on(SOCKET_EVENTS.C2S_CHANGE_STATE_EVENT, async (newState) => {
    try {
      if (newState === player.getState()) return;

      const lockAcquired = await lockManager.withLock(async () => {
        // Change state
        if (newState === PLAYER_STATE.PLAYING) {
          await player.play();
        } else {
          await player.pause();
        }

        io.emit(SOCKET_EVENTS.S2C_STATE_CHANGED_EVENT, newState);
      });

      if (!lockAcquired) {
        console.log('Lock acquisition failed for state change, request denied');
        return;
      }
    } catch (error) {
      console.error('Error changing state:', error);
    }
  });
};