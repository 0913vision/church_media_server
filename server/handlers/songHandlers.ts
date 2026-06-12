import { SOCKET_EVENTS } from '../constants/socketConfig.js';
import { PLAYER_STATE, SONG_TYPE } from '../constants/playerStates.js';
import { DEFAULT_SONG_VOLUMES } from '../constants/playerConfig.js';
import { log } from '../utils/logger.js';

/**
 * Registers song-related socket event handlers
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} deps - Shared dependencies (see handlers/index.js)
 */
export const registerSongHandlers = (socket, deps) => {
  const { notifier, player, lockCoordinator, adminSessionManager } = deps;

  /**
   * Handle current song get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_CURRENT_SONG_EVENT, async () => {
    try {
      notifier.songChanged(player.getCurrentSong(), socket);
    } catch (error) {
      log.error('songHandler', socket, 'Error getting current song', { error: error.message });
    }
  });

  /**
   * Handle song change request — audio resource operation.
   * The client still sends its own idea of the current song as the first
   * argument (protocol unchanged), but the server's state is authoritative,
   * so that value is ignored.
   */
  socket.on(SOCKET_EVENTS.C2S_CHANGE_SONG_EVENT, async (_clientCurrentSong, newSong) => {
    try {
      if (!Object.values(SONG_TYPE).includes(newSong)) {
        log.warn('songHandler', socket, 'Invalid song requested, request denied', { newSong });
        return;
      }
      if (newSong === player.getCurrentSong()) return;

      const isAdmin = adminSessionManager.isAdminSocket(socket);
      const lockAcquired = await lockCoordinator.withAudioLock(isAdmin, async () => {
        // Change song (handles pause, switch, volume change internally)
        await player.changeSong(newSong);

        notifier.stateChanged(PLAYER_STATE.PAUSED);
        notifier.songChanged(newSong);
        notifier.volumeChanged(DEFAULT_SONG_VOLUMES[newSong]);
      });

      if (!lockAcquired) {
        log.warn('songHandler', socket, 'Song change blocked (admin lock or audio busy)');
        return;
      }
    } catch (error) {
      log.error('songHandler', socket, 'Error changing song', { error: error.message, currentSong, newSong });
    }
  });
};
