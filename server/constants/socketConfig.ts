import type { Socket } from 'socket.io';
import { requireIntEnv } from '../utils/env.ts';
import type { ClientToServerEventsUnsafe, ServerToClientEvents } from '../protocol.ts';

// Note(yoochan.kim): transport settings only; the protocol is generated from protocol/protocol.json.
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

export interface SocketData {
  /** Absent until the client says hello */
  client?: string;
  /** False until a hello with a protocol version this server speaks; no write or invoke before that. */
  accepted?: boolean;
}

/** Inbound payloads are `unknown`, as they come from untrusted clients; each is narrowed before use. */
export type ServerSocket = Socket<ClientToServerEventsUnsafe, ServerToClientEvents, Record<string, never>, SocketData>;
