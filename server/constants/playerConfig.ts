import { PlaybackState, MuteState } from '../protocol.ts';
import type { SongId } from './songs.ts';

// Note(yoochan.kim): Full player state shape
export interface PlayerConfig {
  serverVolume: number;
  muted: MuteState;
  state: PlaybackState;
  currentSong: SongId;
}

// Note(yoochan.kim): Initial player configuration. The starting song is absent
// on purpose: the manifest names the deck's songs, so only the composition root
// knows which one exists to start on.
export const INITIAL_PLAYER_CONFIG: Omit<PlayerConfig, 'currentSong'> = {
  serverVolume: 50,
  muted: MuteState.UNMUTED,
  state: PlaybackState.PAUSED
};
