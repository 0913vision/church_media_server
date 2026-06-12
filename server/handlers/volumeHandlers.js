import { SOCKET_EVENTS } from '../constants/socketConfig.js';
import { log } from '../utils/logger.js';

/**
 * Registers volume-related socket event handlers
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} deps - Shared dependencies (see handlers/index.js)
 */
export const registerVolumeHandlers = (socket, deps) => {
  const { io, player, lockCoordinator } = deps;
  /**
   * Handle volume get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_VOLUME_EVENT, async () => {
    try {
      socket.emit(SOCKET_EVENTS.S2C_VOLUME_CHANGED_EVENT, player.getVolume());
    } catch (error) {
      log.error('volumeHandler', socket, 'Error getting volume', { error: error.message });
    }
  });

  /**
   * Handle volume change request (audio resource operation)
   */
  socket.on(SOCKET_EVENTS.C2S_CHANGE_VOLUME_EVENT, async (newVolume) => {
    try {
      const lockAcquired = await lockCoordinator.withAudioLock(socket, async () => {
        player.setVolume(newVolume);
        io.emit(SOCKET_EVENTS.S2C_VOLUME_CHANGED_EVENT, newVolume);
      });

      if (!lockAcquired) {
        log.warn('volumeHandler', socket, 'Volume change blocked (admin lock or audio busy)');
        return;
      }
    } catch (error) {
      log.error('volumeHandler', socket, 'Error changing volume', { error: error.message, newVolume });
    }
  });
};
