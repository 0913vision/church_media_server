import { SOCKET_EVENTS } from '../constants/socketConfig.js';

/**
 * Registers mute-related socket event handlers
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} io - Socket.IO server instance
 * @param {Player} player - Player instance
 */
export const registerMuteHandlers = (socket, io, player) => {
  /**
   * Handle mute status get request
   */
  socket.on(SOCKET_EVENTS.C2S_GET_MUTE_EVENT, async () => {
    try {
      const muteStatus = player.getMute();
      socket.emit(SOCKET_EVENTS.S2C_MUTE_CHANGED_EVENT, muteStatus);
    } catch (error) {
      console.error('Error getting mute status:', error);
    }
  });

  /**
   * Handle mute change request
   */
  socket.on(SOCKET_EVENTS.C2S_CHANGE_MUTE_EVENT, async (newMute) => {
    try {
      player.setMute(newMute);
      io.emit(SOCKET_EVENTS.S2C_MUTE_CHANGED_EVENT, newMute);
    } catch (error) {
      console.error('Error changing mute status:', error);
    }
  });
};