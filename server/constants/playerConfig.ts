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
// knows which one exists to start on. 53 is the 50 it used to be, read on the
// fader-shaped scale.
export const INITIAL_PLAYER_CONFIG: Omit<PlayerConfig, 'currentSong'> = {
  serverVolume: 53,
  muted: MuteState.UNMUTED,
  state: PlaybackState.PAUSED
};
