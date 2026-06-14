import type { ServerSocket } from '../constants/socketConfig.ts';
import { SOCKET_EVENTS } from '../constants/socketConfig.ts';
import { ADMIN_CONFIG } from '../constants/authConfig.ts';
import { verifyPassword } from '../auth/password.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';
import type { HandlerDeps } from './index.ts';

/**
 * Registers authentication and admin-lock socket event handlers
 */
export const registerAuthHandlers = (socket: ServerSocket, deps: HandlerDeps): void => {
  const { notifier, adminSessionManager, lockCoordinator } = deps;

  /**
   * Handle admin authentication request
   */
  socket.on(SOCKET_EVENTS.C2S_AUTHENTICATE_ADMIN_EVENT, (password: unknown) => {
    try {
      if (typeof password === 'string' && verifyPassword(password, ADMIN_CONFIG.ADMIN_PASSWORD_HASH)) {
        adminSessionManager.addAdminSocket(socket);
        notifier.adminAuthenticated(socket, true);
        log.info('authHandler', socket, 'Socket authenticated as admin');
      } else {
        notifier.adminAuthenticated(socket, false);
        log.warn('authHandler', socket, 'Socket failed admin authentication');
      }
    } catch (error) {
      log.error('authHandler', socket, 'Error during admin authentication', { error: errorMessage(error) });
      notifier.adminAuthenticated(socket, false);
    }
  });

  /**
   * Handle admin lock toggle. The admin lock is global server state that blocks
   * all non-admin submissions while on; any authenticated admin may turn it on
   * or off, and the new value is broadcast to everyone.
   * @param locked - true to engage the gate, false to release it
   */
  socket.on(SOCKET_EVENTS.C2S_SET_ADMIN_LOCK_EVENT, (locked: unknown) => {
    try {
      if (typeof locked !== 'boolean') {
        log.warn('authHandler', socket, 'Invalid admin lock value, request denied', { locked });
        return;
      }
      if (!adminSessionManager.isAdminSocket(socket)) {
        log.warn('authHandler', socket, 'Non-admin attempted to set admin lock');
        return;
      }

      lockCoordinator.setAdminLock(locked);
      log.info('authHandler', socket, 'Admin lock set', { locked });
    } catch (error) {
      log.error('authHandler', socket, 'Error setting admin lock', { error: errorMessage(error), locked });
    }
  });
};
