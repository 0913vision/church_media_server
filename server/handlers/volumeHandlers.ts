import type { Socket } from 'socket.io';
import { SOCKET_EVENTS } from '../constants/socketConfig.ts';
import { log } from '../utils/logger.ts';
import type { HandlerDeps } from './index.ts';

/**
 * Registers volume-related socket event handlers
 */
export const registerVolumeHandlers = (socket: Socket, deps: HandlerDeps): void => {
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
  socket.on(SOCKET_EVENTS.C2S_CHANGE_VOLUME_EVENT, async (newVolume: unknown) => {
    try {
      if (typeof newVolume !== 'number' || !Number.isFinite(newVolume) || newVolume < 0 || newVolume > 100) {
        log.warn('volumeHandler', socket, 'Invalid volume requested, request denied', { newVolume });
        return;
      }

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
