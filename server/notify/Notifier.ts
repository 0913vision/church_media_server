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

type TypedServer = Server<ClientToServerEventsUnsafe, ServerToClientEvents, Record<string, never>, SocketData>;

/** Sole S2C emitter; state travels only as a patch, to everyone or, for per-connection attributes, to one client. */
class Notifier {
  constructor(private readonly io: TypedServer) {}

  state(patch: StatePatch): void {
    this.io.emit(S2C.STATE, patch);
  }

  /** For the full state after hello, read replies, and per-connection attributes such as isAdmin. */
  stateTo(socket: ServerSocket, patch: StatePatch): void {
    socket.emit(S2C.STATE, patch);
  }

  /** Answers a hello: what this server speaks and what it implements. */
  ready(socket: ServerSocket, payload: S2CPayloads['ready']): void {
    socket.emit(S2C.READY, payload);
  }

  /** Every refusal goes back with its reason, so a client explains itself instead of appearing to do nothing. */
  rejected(socket: ServerSocket, target: string, reason: RejectReason): void {
    socket.emit(S2C.REJECTED, { target, reason });
  }

  /** Clients take "now" from this, not their own clock; the offset rides along so both come from one instant. */
  ping(at: Date, offsetSec: number): void {
    this.io.emit(S2C.PING, { at: formatInstant(at), offsetSec });
  }
}

export default Notifier;
