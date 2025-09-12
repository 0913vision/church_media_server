import { SOCKET_EVENTS } from '../constants/socketConfig.js';
import { ADMIN_CONFIG } from '../constants/authConfig.js';

/**
 * Registers authentication-related socket event handlers
 * @param {Object} socket - Socket.IO socket instance
 * @param {AdminSessionManager} adminSessionManager - Admin session manager instance
 */
export const registerAuthHandlers = (socket, adminSessionManager) => {
  /**
   * Handle admin authentication request
   */
  socket.on(SOCKET_EVENTS.C2S_AUTHENTICATE_ADMIN_EVENT, (password) => {
    try {
      if (password === ADMIN_CONFIG.ADMIN_PASSWORD) {
        adminSessionManager.addAdminSocket(socket);
        socket.emit(SOCKET_EVENTS.S2C_ADMIN_AUTHENTICATED_EVENT, { success: true });
        console.log(`Socket ${socket.id} authenticated as admin`);
      } else {
        socket.emit(SOCKET_EVENTS.S2C_ADMIN_AUTHENTICATED_EVENT, { success: false });
        console.log(`Socket ${socket.id} failed admin authentication`);
      }
    } catch (error) {
      console.error('Error during admin authentication:', error);
      socket.emit(SOCKET_EVENTS.S2C_ADMIN_AUTHENTICATED_EVENT, { success: false });
    }
  });
};