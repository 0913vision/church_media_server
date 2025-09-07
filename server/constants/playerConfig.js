import { SONG_TYPE, PLAYER_STATE, MUTE_STATE } from './socketConfig.js';

// Default volumes for each song
export const DEFAULT_SONG_VOLUMES = {
  [SONG_TYPE.SLOW]: 50,
  [SONG_TYPE.FAST]: 35
};

// Initial player configuration
export const INITIAL_PLAYER_CONFIG = {
  serverVolume: 50,
  muted: MUTE_STATE.UNMUTED,
  state: PLAYER_STATE.PAUSED,
  currentSong: SONG_TYPE.SLOW
};