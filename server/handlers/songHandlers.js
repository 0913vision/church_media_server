import { SOCKET_EVENTS, PLAYER_STATE } from '@/constants/socketConfig';
import { DEFAULT_SONG_VOLUMES } from '@/constants/playerConfig';

/**
 * Registers song-related socket event handlers
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} io - Socket.IO server instance
 * @param {Player} player - Player instance
 * @param {NetworkLockManager} lockManager - Network lock manager instance
 */
export const registerSongHandlers = (socket, io, player, lockManager) => {
  /**
   * Handle current song get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_CURRENT_SONG_EVENT, async () => {
    try {
      const currentSong = player.getCurrentSong();
      socket.emit(SOCKET_EVENTS.S2C_SONG_CHANGED_EVENT, currentSong);
    } catch (error) {
      console.error('Error getting current song:', error);
    }
  });

  /**
   * Handle song change request
   */
  socket.on(SOCKET_EVENTS.C2S_CHANGE_SONG_EVENT, async (currentSong, newSong) => {
    try {
      const lockAcquired = await lockManager.withLock(async () => {
        // Change song (this handles pause, switch, volume change internally)
        await player.changeSong(currentSong, newSong);

        // Emit state and song changes
        io.emit(SOCKET_EVENTS.S2C_STATE_CHANGED_EVENT, PLAYER_STATE.PAUSED);
        io.emit(SOCKET_EVENTS.S2C_SONG_CHANGED_EVENT, newSong);
        io.emit(SOCKET_EVENTS.S2C_VOLUME_CHANGED_EVENT, DEFAULT_SONG_VOLUMES[newSong]);
      });

      if (!lockAcquired) {
        console.log('Lock acquisition failed for song change, request denied');
        return;
      }
    } catch (error) {
      console.error('Error changing song:', error);
    }
  });
};