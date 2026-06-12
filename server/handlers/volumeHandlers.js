import { SOCKET_EVENTS } from '../constants/socketConfig.js';
import { log } from '../utils/logger.js';

/**
 * Registers volume-related socket event handlers
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} deps - Shared dependencies (see handlers/index.js)
 */
export const registerVolumeHandlers = (socket, deps) => {
  const { notifier, player, lockCoordinator, adminSessionManager } = deps;

  /**
   * Handle volume get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_VOLUME_EVENT, async () => {
    try {
      notifier.volumeChanged(player.getVolume(), socket);
    } catch (error) {
      log.error('volumeHandler', socket, 'Error getting volume', { error: error.message });
    }
  });

  /**
   * Handle volume change request (audio resource operation)
   */
  socket.on(SOCKET_EVENTS.C2S_CHANGE_VOLUME_EVENT, async (newVolume) => {
    try {
      const isAdmin = adminSessionManager.isAdminSocket(socket);
      const lockAcquired = await lockCoordinator.withAudioLock(isAdmin, async () => {
        player.setVolume(newVolume);
        notifier.volumeChanged(newVolume);
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
