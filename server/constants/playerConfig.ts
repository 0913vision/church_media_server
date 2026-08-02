import { PlaybackState, MuteState } from '../protocol.ts';
import { SongType } from './songs.ts';

// Note(yoochan.kim): Default volumes for each song
export const DEFAULT_SONG_VOLUMES: Record<SongType, number> = {
  [SongType.CALM]: 50,
  [SongType.FERVENT]: 35
};

// Note(yoochan.kim): Full player state shape
export interface PlayerConfig {
  serverVolume: number;
  muted: MuteState;
  state: PlaybackState;
  currentSong: SongType;
}

// Note(yoochan.kim): Initial player configuration
export const INITIAL_PLAYER_CONFIG: PlayerConfig = {
  serverVolume: 50,
  muted: MuteState.UNMUTED,
  state: PlaybackState.PAUSED,
  currentSong: SongType.CALM
};
