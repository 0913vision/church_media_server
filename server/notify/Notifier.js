import { SOCKET_EVENTS } from '../constants/socketConfig.js';

/**
 * Single owner of all S2C emission: every outgoing event name and the
 * broadcast-vs-reply decision lives here, so the rest of the server speaks in
 * domain terms ("volume changed") rather than transport terms (io.emit).
 *
 * The protocol uses the same event for both scopes: a CHANGE broadcasts the
 * new value to everyone, a GET replies the current value to the requester.
 * Each method therefore broadcasts by default and replies to a single client
 * when a target socket is passed.
 */
class Notifier {
  #io;

  /**
   * @param {Object} io - Socket.IO server instance
   */
  constructor(io) {
    this.#io = io;
  }

  /**
   * Emits to all clients, or to one client when a target socket is given.
   * @private
   */
  #emit(eventName, payload, socket) {
    (socket ?? this.#io).emit(eventName, payload);
  }

  stateChanged(state, socket) {
    this.#emit(SOCKET_EVENTS.S2C_STATE_CHANGED_EVENT, state, socket);
  }

  volumeChanged(volume, socket) {
    this.#emit(SOCKET_EVENTS.S2C_VOLUME_CHANGED_EVENT, volume, socket);
  }

  muteChanged(mute, socket) {
    this.#emit(SOCKET_EVENTS.S2C_MUTE_CHANGED_EVENT, mute, socket);
  }

  songChanged(song, socket) {
    this.#emit(SOCKET_EVENTS.S2C_SONG_CHANGED_EVENT, song, socket);
  }

  audioLockChanged(locked, socket) {
    this.#emit(SOCKET_EVENTS.S2C_LOCK_CHANGED_EVENT, locked, socket);
  }

  adminLockChanged(locked, socket) {
    this.#emit(SOCKET_EVENTS.S2C_ADMIN_LOCK_CHANGED_EVENT, locked, socket);
  }

  /**
   * Authentication result — always a single-recipient reply.
   * @param {Object} socket - The authenticating socket
   * @param {boolean} success
   */
  adminAuthenticated(socket, success) {
    socket.emit(SOCKET_EVENTS.S2C_ADMIN_AUTHENTICATED_EVENT, { success });
  }

  ping() {
    this.#io.emit(SOCKET_EVENTS.S2C_PING_EVENT);
  }
}

export default Notifier;
