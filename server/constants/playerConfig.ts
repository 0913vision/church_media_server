import { SongType, PlaybackState, MuteState } from '../protocol.ts';

// Default volumes for each song
export const DEFAULT_SONG_VOLUMES: Record<SongType, number> = {
  [SongType.SLOW]: 50,
  [SongType.FAST]: 35
};

// Full player state shape
export interface PlayerConfig {
  serverVolume: number;
  muted: MuteState;
  state: PlaybackState;
  currentSong: SongType;
}

// Initial player configuration
export const INITIAL_PLAYER_CONFIG: PlayerConfig = {
  serverVolume: 50,
  muted: MuteState.UNMUTED,
  state: PlaybackState.PAUSED,
  currentSong: SongType.SLOW
};
