import type { Socket } from 'socket.io';
import { requireIntEnv } from '../utils/env.ts';
import type { ClientToServerEventsUnsafe, ServerToClientEvents } from '../protocol.ts';

// Note(yoochan.kim): Socket server configuration constants. The protocol itself lives in
// protocol/protocol.json and is generated — this file only carries transport
// settings.
interface ServerConfig {
  PORT: number;
  PING_INTERVAL_MS: number;
  CORS: {
    origin: string;
    methods: string[];
  };
}

export const SOCKET_CONFIG: ServerConfig = {
  PORT: requireIntEnv('PORT'),
  PING_INTERVAL_MS: 30000,
  CORS: {
    origin: "*",
    methods: ["GET", "POST"]
  }
};

/**
 * Per-connection bookkeeping. `accepted` starts false: a client must say hello
 * with a protocol version this server speaks before it may write or invoke.
 */
export interface SocketData {
  /** Absent until the client says hello */
  client?: string;
  accepted?: boolean;
}

/**
 * Server-side socket. Inbound payloads are typed `unknown` because they arrive
 * from untrusted clients; each is narrowed before use.
 */
export type ServerSocket = Socket<ClientToServerEventsUnsafe, ServerToClientEvents, Record<string, never>, SocketData>;
