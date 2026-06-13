import type { SongType } from '../constants/playerStates.ts';

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
  changeSong(currentSong: SongType, newSong: SongType): void;
  loadLastSongTime(song: SongType): Promise<void>;
}
