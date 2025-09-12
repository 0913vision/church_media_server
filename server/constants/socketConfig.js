// Server configuration constants
export const SOCKET_CONFIG = {
  PORT: process.env.PORT,
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

  // Server to Client events
  S2C_STATE_CHANGED_EVENT: 'stateChanged',
  S2C_VOLUME_CHANGED_EVENT: 'volumeChanged',
  S2C_MUTE_CHANGED_EVENT: 'muteChanged',
  S2C_SONG_CHANGED_EVENT: 'songChanged',
  S2C_LOCK_CHANGED_EVENT: 'lockChanged',
  
  // Admin response events
  S2C_ADMIN_AUTHENTICATED_EVENT: 'adminAuthenticated'
};

// Player states (same as client)
export const PLAYER_STATE = {
  PAUSED: 0,
  PLAYING: 1
};

// Mute states (same as client)
export const MUTE_STATE = {
  UNMUTED: 0,
  MUTED: 1
};

// Song types (same as client)
export const SONG_TYPE = {
  SLOW: 'slow',
  FAST: 'fast'
};

