import type { Server, Socket } from 'socket.io';
import { SOCKET_EVENTS } from '../constants/socketConfig.ts';
import type { SocketEventName } from '../constants/socketConfig.ts';
import type { PlayerState, MuteState, SongType } from '../constants/playerStates.ts';

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
  constructor(private readonly io: Server) {}

  /**
   * Emits to all clients, or to one client when a target socket is given.
   */
  private emit(eventName: SocketEventName, payload: unknown, socket?: Socket): void {
    (socket ?? this.io).emit(eventName, payload);
  }

  stateChanged(state: PlayerState, socket?: Socket): void {
    this.emit(SOCKET_EVENTS.S2C_STATE_CHANGED_EVENT, state, socket);
  }

  volumeChanged(volume: number, socket?: Socket): void {
    this.emit(SOCKET_EVENTS.S2C_VOLUME_CHANGED_EVENT, volume, socket);
  }

  muteChanged(mute: MuteState, socket?: Socket): void {
    this.emit(SOCKET_EVENTS.S2C_MUTE_CHANGED_EVENT, mute, socket);
  }

  songChanged(song: SongType, socket?: Socket): void {
    this.emit(SOCKET_EVENTS.S2C_SONG_CHANGED_EVENT, song, socket);
  }

  audioLockChanged(locked: boolean, socket?: Socket): void {
    this.emit(SOCKET_EVENTS.S2C_LOCK_CHANGED_EVENT, locked, socket);
  }

  adminLockChanged(locked: boolean, socket?: Socket): void {
    this.emit(SOCKET_EVENTS.S2C_ADMIN_LOCK_CHANGED_EVENT, locked, socket);
  }

  /**
   * Authentication result — always a single-recipient reply.
   */
  adminAuthenticated(socket: Socket, success: boolean): void {
    socket.emit(SOCKET_EVENTS.S2C_ADMIN_AUTHENTICATED_EVENT, { success });
  }

  ping(): void {
    this.io.emit(SOCKET_EVENTS.S2C_PING_EVENT);
  }
}

export default Notifier;
