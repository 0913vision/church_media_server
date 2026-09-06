import type { SongId } from '../constants/songs.ts';

/**
 * The audio output surface the Player depends on.
 *
 * AudioDevice (real playback over MPV) implements it; tests substitute a fake.
 * This decouples Player from the hardware/FFI layer so player logic (mute,
 * volume memory, song switching) can be unit-tested in isolation.
 */
export interface AudioOutput {
  setVolume(volume: number): void;
  /**
   * Start and stop. Both fade by default; pass false where there is no cut to
   * cover — a song beginning at its beginning, or one that has just reached its
   * own end. A fade there is only a delay.
   */
  resume(fade?: boolean): Promise<void>;
  pause(fade?: boolean): Promise<void>;
  /** Saves the song's live playback position into its time memory */
  captureSongTime(song: SongId): void;
  /** Whether what is loaded repeats */
  setLoop(loop: boolean): void;
  /** Whether the file on the deck has run out */
  hasEnded(): boolean;
  /** Plays a library file from an offset, repeating only if asked */
  playFileAt(filePath: string, offsetSec: number, loop?: boolean): Promise<void>;
  /** Puts a library file on the deck, paused at its start */
  loadFile(filePath: string, loop: boolean): void;
  /** Loads a song file onto the looping two-song deck (no position save) */
  loadSong(song: SongId): void;
  loadLastSongTime(song: SongId): Promise<void>;
}
