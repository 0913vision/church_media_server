import { SOCKET_EVENTS, PLAYER_STATE } from '../constants/socketConfig.js';
import { DEFAULT_SONG_VOLUMES } from '../constants/playerConfig.js';
import { log } from '../utils/logger.js';

/**
 * Registers song-related socket event handlers
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} io - Socket.IO server instance
 * @param {Player} player - Player instance
 * @param {LockCoordinator} lockCoordinator - Lock coordinator instance
 */
export const registerSongHandlers = (socket, io, player, lockCoordinator) => {
  /**
   * Handle current song get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_CURRENT_SONG_EVENT, async () => {
    try {
      const currentSong = !lockCoordinator.isAdminOperationActive() 
        ? player.getCurrentSong() 
        : lockCoordinator.getSavedUserState()?.currentSong;
      socket.emit(SOCKET_EVENTS.S2C_SONG_CHANGED_EVENT, currentSong);
    } catch (error) {
      log.error('songHandler', socket, 'Error getting current song', { error: error.message });
    }
  });

  /**
   * Handle song change request
   */
  socket.on(SOCKET_EVENTS.C2S_CHANGE_SONG_EVENT, async (currentSong, newSong) => {
    try {
      const lockAcquired = await lockCoordinator.withUserLock(async () => {
        await player.changeSong(currentSong, newSong);

        io.emit(SOCKET_EVENTS.S2C_STATE_CHANGED_EVENT, PLAYER_STATE.PAUSED);
        io.emit(SOCKET_EVENTS.S2C_SONG_CHANGED_EVENT, newSong);
        io.emit(SOCKET_EVENTS.S2C_VOLUME_CHANGED_EVENT, DEFAULT_SONG_VOLUMES[newSong]);
      });

      if (!lockAcquired) {
        log.warn('songHandler', socket, 'Lock acquisition failed for song change, request denied');
        return;
      }
    } catch (error) {
      log.error('songHandler', socket, 'Error changing song', { error: error.message, currentSong, newSong });
    }
  });
};