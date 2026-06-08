import { SOCKET_EVENTS } from '../constants/socketConfig.js';
import { ADMIN_CONFIG } from '../constants/authConfig.js';
import { log } from '../utils/logger.js';

/**
 * Registers authentication and admin-lock socket event handlers
 * @param {Object} socket - Socket.IO socket instance
 * @param {AdminSessionManager} adminSessionManager - Admin session manager instance
 * @param {LockCoordinator} lockCoordinator - Lock coordinator instance
 */
export const registerAuthHandlers = (socket, adminSessionManager, lockCoordinator) => {
  /**
   * Handle admin authentication request
   */
  socket.on(SOCKET_EVENTS.C2S_AUTHENTICATE_ADMIN_EVENT, (password) => {
    try {
      if (password === ADMIN_CONFIG.ADMIN_PASSWORD) {
        adminSessionManager.addAdminSocket(socket);
        socket.emit(SOCKET_EVENTS.S2C_ADMIN_AUTHENTICATED_EVENT, { success: true });
        log.info('authHandler', socket, 'Socket authenticated as admin');
      } else {
        socket.emit(SOCKET_EVENTS.S2C_ADMIN_AUTHENTICATED_EVENT, { success: false });
        log.warn('authHandler', socket, 'Socket failed admin authentication');
      }
    } catch (error) {
      log.error('authHandler', socket, 'Error during admin authentication', { error: error.message });
      socket.emit(SOCKET_EVENTS.S2C_ADMIN_AUTHENTICATED_EVENT, { success: false });
    }
  });

  /**
   * Handle admin lock toggle (explicit acquire/release by an authenticated admin).
   * Acquiring blocks all other users from submitting new operations; in-flight
   * operations are unaffected. Broadcasts on its own (admin) lock event.
   * @param {boolean} locked - true to acquire, false to release
   */
  socket.on(SOCKET_EVENTS.C2S_SET_ADMIN_LOCK_EVENT, (locked) => {
    try {
      if (!adminSessionManager.isAdminSocket(socket)) {
        log.warn('authHandler', socket, 'Non-admin attempted to set admin lock');
        return;
      }

      if (locked) {
        lockCoordinator.acquireAdminLock(socket);
        log.info('authHandler', socket, 'Admin lock acquired');
      } else {
        lockCoordinator.releaseAdminLock(socket);
        log.info('authHandler', socket, 'Admin lock released');
      }
    } catch (error) {
      log.error('authHandler', socket, 'Error setting admin lock', { error: error.message, locked });
    }
  });
};
