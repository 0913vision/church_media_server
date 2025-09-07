import { SOCKET_EVENTS } from '@/constants/socketConfig';

/**
 * Registers volume-related socket event handlers
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} io - Socket.IO server instance
 * @param {Player} player - Player instance
 */
export const registerVolumeHandlers = (socket, io, player) => {
  /**
   * Handle volume get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_VOLUME_EVENT, async () => {
    try {
      const currentVolume = player.getVolume();
      socket.emit(SOCKET_EVENTS.S2C_VOLUME_CHANGED_EVENT, currentVolume);
    } catch (error) {
      console.error('Error getting volume:', error);
    }
  });

  /**
   * Handle volume change request
   */
  socket.on(SOCKET_EVENTS.C2S_CHANGE_VOLUME_EVENT, async (newVolume) => {
    try {
      player.setVolume(newVolume);
      io.emit(SOCKET_EVENTS.S2C_VOLUME_CHANGED_EVENT, newVolume);
    } catch (error) {
      console.error('Error changing volume:', error);
    }
  });
};