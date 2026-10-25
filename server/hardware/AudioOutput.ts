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
   * own end. A fade there is only a delay. A fade takes durationMs, any length
   * (FADE_IN_MS or FADE_OUT_MS unless given). onSounding runs the moment the sound starts, before a
   * fade in has finished.
   */
  resume(fade?: boolean, onSounding?: () => void, durationMs?: number): Promise<void>;
  pause(fade?: boolean, durationMs?: number): Promise<void>;
  /** Whether the deck is past the opening of what it holds, so starting it is a cut */
  isPartWay(): boolean;
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
