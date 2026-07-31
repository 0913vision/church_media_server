import type { SongType } from '../constants/songs.ts';

/**
 * The audio output surface the Player depends on.
 *
 * AudioDevice (real playback over MPV) implements it; tests substitute a fake.
 * This decouples Player from the hardware/FFI layer so player logic (mute,
 * volume memory, song switching) can be unit-tested in isolation.
 */
export interface AudioOutput {
  setVolume(volume: number): void;
  resume(): Promise<void>;
  pause(): Promise<void>;
  /** Saves the song's live playback position into its time memory */
  captureSongTime(song: SongType): void;
  /** Loads a song file onto the looping two-song deck (no position save) */
  loadSong(song: SongType): void;
  loadLastSongTime(song: SongType): Promise<void>;
  playFileAt(filePath: string, offsetSec: number): Promise<void>;
}
