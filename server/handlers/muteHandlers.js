import { SOCKET_EVENTS } from '../constants/socketConfig.js';
import { log } from '../utils/logger.js';

/**
 * Registers mute-related socket event handlers
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} deps - Shared dependencies (see handlers/index.js)
 */
export const registerMuteHandlers = (socket, deps) => {
  const { io, player, lockCoordinator, adminSessionManager } = deps;
  /**
   * Handle mute status get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_MUTE_EVENT, async () => {
    try {
      socket.emit(SOCKET_EVENTS.S2C_MUTE_CHANGED_EVENT, player.getMute());
    } catch (error) {
      log.error('muteHandler', socket, 'Error getting mute status', { error: error.message });
    }
  });

  /**
   * Handle mute change request (audio resource operation)
   */
  socket.on(SOCKET_EVENTS.C2S_CHANGE_MUTE_EVENT, async (newMute) => {
    try {
      const isAdmin = adminSessionManager.isAdminSocket(socket);
      const lockAcquired = await lockCoordinator.withAudioLock(isAdmin, async () => {
        player.setMute(newMute);
        io.emit(SOCKET_EVENTS.S2C_MUTE_CHANGED_EVENT, newMute);
      });

      if (!lockAcquired) {
        log.warn('muteHandler', socket, 'Mute change blocked (admin lock or audio busy)');
        return;
      }
    } catch (error) {
      log.error('muteHandler', socket, 'Error changing mute status', { error: error.message, newMute });
    }
  });
};
