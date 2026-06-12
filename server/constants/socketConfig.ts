import type { Socket } from 'socket.io';
import { requireIntEnv } from '../utils/env.ts';
import type { PlayerState, MuteState, SongType } from './playerStates.ts';

// Server configuration constants
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

// Socket events
export const SOCKET_EVENTS = {
  // Client to Server events
  C2S_GET_VOLUME_EVENT: 'getVolume',
  C2S_GET_STATE_EVENT: 'getState',
  C2S_GET_MUTE_EVENT: 'getMute',
  C2S_GET_CURRENT_SONG_EVENT: 'getCurrentSong',
  C2S_GET_LOCK_EVENT: 'getLock',
  C2S_CHANGE_SONG_EVENT: 'changeSong',
  C2S_CHANGE_VOLUME_EVENT: 'changeVolume',
  C2S_CHANGE_STATE_EVENT: 'changeState',
  C2S_CHANGE_MUTE_EVENT: 'changeMute',
  C2S_MIC_ON_EVENT: 'micOn',
  C2S_AUX_ON_EVENT: 'auxOn',

  // Admin events
  C2S_AUTHENTICATE_ADMIN_EVENT: 'authenticateAdmin',
  C2S_SET_ADMIN_LOCK_EVENT: 'setAdminLock',

  // Server to Client events
  S2C_STATE_CHANGED_EVENT: 'stateChanged',
  S2C_VOLUME_CHANGED_EVENT: 'volumeChanged',
  S2C_MUTE_CHANGED_EVENT: 'muteChanged',
  S2C_SONG_CHANGED_EVENT: 'songChanged',
  // Audio (resource) lock state — held only while the audio device is
  // mid-transition (play/pause/song change). Kept on the existing event name.
  S2C_LOCK_CHANGED_EVENT: 'lockChanged',
  // Admin (global gate) lock state — entirely separate channel from the
  // audio lock above. Broadcast when an admin acquires/releases the gate.
  S2C_ADMIN_LOCK_CHANGED_EVENT: 'adminLockChanged',

  // Admin response events
  S2C_ADMIN_AUTHENTICATED_EVENT: 'adminAuthenticated',

  // System events
  S2C_PING_EVENT: 'ping'
} as const;

/**
 * S2C protocol map: every outgoing event with its exact payload type.
 * Parameterizing socket.io's Server/Socket with this makes every emit
 * compile-time checked against the protocol.
 */
export interface ServerToClientEvents {
  stateChanged: (state: PlayerState) => void;
  volumeChanged: (volume: number) => void;
  muteChanged: (mute: MuteState) => void;
  songChanged: (song: SongType) => void;
  lockChanged: (locked: boolean) => void;
  adminLockChanged: (locked: boolean) => void;
  adminAuthenticated: (result: { success: boolean }) => void;
  ping: () => void;
}

/**
 * C2S protocol map.
 * Note(yoochan.kim): payload parameters are deliberately `unknown` — they
 * arrive from untrusted clients over the wire, and each handler narrows them
 * with the runtime type guards before use.
 */
export interface ClientToServerEvents {
  getVolume: () => void;
  getState: () => void;
  getMute: () => void;
  getCurrentSong: () => void;
  getLock: () => void;
  changeSong: (clientCurrentSong: unknown, newSong: unknown) => void;
  changeVolume: (volume: unknown) => void;
  changeState: (state: unknown) => void;
  changeMute: (mute: unknown) => void;
  micOn: () => void;
  auxOn: () => void;
  authenticateAdmin: (password: unknown) => void;
  setAdminLock: (locked: unknown) => void;
}

/** Server-side socket with the protocol applied */
export type ServerSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
