import type { Server } from 'socket.io';
import { S2C } from '../protocol.ts';
import { formatInstant } from '../utils/instant.ts';
import type {
  ClientToServerEventsUnsafe,
  RejectReason,
  S2CPayloads,
  ServerToClientEvents,
  StatePatch,
} from '../protocol.ts';
import type { ServerSocket, SocketData } from '../constants/socketConfig.ts';

/** Socket.IO server parameterized with this project's protocol maps */
type TypedServer = Server<ClientToServerEventsUnsafe, ServerToClientEvents, Record<string, never>, SocketData>;

/**
 * Single owner of all S2C emission: every outgoing event name and the
 * broadcast-vs-reply decision lives here, so the rest of the server speaks in
 * domain terms ("these attributes changed") rather than transport terms.
 *
 * The protocol has exactly one carrier of state, so this class is small: a
 * state patch either goes to everyone or, for per-connection attributes like
 * isAdmin, to the one client it describes.
 */
class Notifier {
  constructor(private readonly io: TypedServer) {}

  /** Announces changed attributes to every connected client. */
  state(patch: StatePatch): void {
    this.io.emit(S2C.STATE, patch);
  }

  /**
   * Sends attributes to one client. Used for the full state after hello, for
   * read replies, and for per-connection attributes such as isAdmin.
   */
  stateTo(socket: ServerSocket, patch: StatePatch): void {
    socket.emit(S2C.STATE, patch);
  }

  /** Answers a hello: what this server speaks and what it implements. */
  ready(socket: ServerSocket, payload: S2CPayloads['ready']): void {
    socket.emit(S2C.READY, payload);
  }

  /**
   * Tells one client why its write or invoke was refused, so it can explain
   * itself rather than appearing to do nothing.
   */
  rejected(socket: ServerSocket, target: string, reason: RejectReason): void {
    socket.emit(S2C.REJECTED, { target, reason });
  }

  /**
   * Heartbeat carrying church time. Clients draw "now" from this instead of
   * their own clock — the whole point of the offset is that local clocks
   * disagree with the one the building follows.
   */
  ping(at: Date): void {
    this.io.emit(S2C.PING, { at: formatInstant(at) });
  }
}

export default Notifier;
