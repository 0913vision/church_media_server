import type { Server } from 'socket.io';
import { SOCKET_EVENTS } from '../constants/socketConfig.ts';
import type { ClientToServerEvents, ServerToClientEvents, ServerSocket } from '../constants/socketConfig.ts';
import type { PlayerState, MuteState, SongType } from '../constants/playerStates.ts';

/** Socket.IO server parameterized with this project's protocol maps */
type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;

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
  constructor(private readonly io: TypedServer) {}

  /**
   * Emits to all clients, or to one client when a target socket is given.
   * The mapped-type generic ties the payload to the event at compile time.
   */
  private emit<E extends keyof ServerToClientEvents>(
    socket: ServerSocket | undefined,
    event: E,
    ...payload: Parameters<ServerToClientEvents[E]>
  ): void {
    if (socket) {
      socket.emit(event, ...payload);
    } else {
      this.io.emit(event, ...payload);
    }
  }

  stateChanged(state: PlayerState, socket?: ServerSocket): void {
    this.emit(socket, SOCKET_EVENTS.S2C_STATE_CHANGED_EVENT, state);
  }

  volumeChanged(volume: number, socket?: ServerSocket): void {
    this.emit(socket, SOCKET_EVENTS.S2C_VOLUME_CHANGED_EVENT, volume);
  }

  muteChanged(mute: MuteState, socket?: ServerSocket): void {
    this.emit(socket, SOCKET_EVENTS.S2C_MUTE_CHANGED_EVENT, mute);
  }

  songChanged(song: SongType, socket?: ServerSocket): void {
    this.emit(socket, SOCKET_EVENTS.S2C_SONG_CHANGED_EVENT, song);
  }

  audioLockChanged(locked: boolean, socket?: ServerSocket): void {
    this.emit(socket, SOCKET_EVENTS.S2C_LOCK_CHANGED_EVENT, locked);
  }

  adminLockChanged(locked: boolean, socket?: ServerSocket): void {
    this.emit(socket, SOCKET_EVENTS.S2C_ADMIN_LOCK_CHANGED_EVENT, locked);
  }

  /**
   * Authentication result — always a single-recipient reply.
   */
  adminAuthenticated(socket: ServerSocket, success: boolean): void {
    socket.emit(SOCKET_EVENTS.S2C_ADMIN_AUTHENTICATED_EVENT, { success });
  }

  ping(): void {
    this.io.emit(SOCKET_EVENTS.S2C_PING_EVENT);
  }
}

export default Notifier;
