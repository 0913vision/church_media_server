import { SOCKET_EVENTS, PLAYER_STATE } from '../constants/socketConfig.js';
import { DEFAULT_SONG_VOLUMES } from '../constants/playerConfig.js';
import { log } from '../utils/logger.js';

/**
 * Registers song-related socket event handlers
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} deps - Shared dependencies (see handlers/index.js)
 */
export const registerSongHandlers = (socket, deps) => {
  const { io, player, lockCoordinator } = deps;
  /**
   * Handle current song get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_CURRENT_SONG_EVENT, async () => {
    try {
      socket.emit(SOCKET_EVENTS.S2C_SONG_CHANGED_EVENT, player.getCurrentSong());
    } catch (error) {
      log.error('songHandler', socket, 'Error getting current song', { error: error.message });
    }
  });

  /**
   * Handle song change request — audio resource operation
   */
  socket.on(SOCKET_EVENTS.C2S_CHANGE_SONG_EVENT, async (currentSong, newSong) => {
    try {
      const lockAcquired = await lockCoordinator.withAudioLock(socket, async () => {
        // Change song (handles pause, switch, volume change internally)
        await player.changeSong(currentSong, newSong);

        io.emit(SOCKET_EVENTS.S2C_STATE_CHANGED_EVENT, PLAYER_STATE.PAUSED);
        io.emit(SOCKET_EVENTS.S2C_SONG_CHANGED_EVENT, newSong);
        io.emit(SOCKET_EVENTS.S2C_VOLUME_CHANGED_EVENT, DEFAULT_SONG_VOLUMES[newSong]);
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
