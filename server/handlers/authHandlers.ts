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
   * Handle admin lock toggle (explicit acquire/release by an authenticated admin).
   * Acquiring blocks all other users from submitting new operations; in-flight
   * operations are unaffected. Broadcasts on its own (admin) lock event.
   * @param locked - true to acquire, false to release
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

      // Log the actual outcome: acquire fails if another admin already holds
      // the lock, and release is a no-op unless this socket is the holder.
      if (locked) {
        const acquired = lockCoordinator.acquireAdminLock(socket.id);
        if (acquired) {
          log.info('authHandler', socket, 'Admin lock acquired');
        } else {
          log.warn('authHandler', socket, 'Admin lock already held, acquire ignored');
        }
      } else {
        const released = lockCoordinator.releaseAdminLock(socket.id);
        if (released) {
          log.info('authHandler', socket, 'Admin lock released');
        } else {
          log.warn('authHandler', socket, 'Admin lock not held by this socket, release ignored');
        }
      }
    } catch (error) {
      log.error('authHandler', socket, 'Error setting admin lock', { error: errorMessage(error), locked });
    }
  });
};
