import { PlaybackState, MuteState } from '../protocol.ts';
import type { SongId } from './songs.ts';

export interface PlayerConfig {
  serverVolume: number;
  muted: MuteState;
  state: PlaybackState;
  currentSong: SongId;
}

// Note(yoochan.kim): no starting song: the manifest names the deck's songs, so only the composition root can pick one.
export const INITIAL_PLAYER_CONFIG: Omit<PlayerConfig, 'currentSong'> = {
  serverVolume: 53,
  muted: MuteState.UNMUTED,
  state: PlaybackState.PAUSED
};
