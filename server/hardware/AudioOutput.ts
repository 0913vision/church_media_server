import type { SongId } from '../constants/songs.ts';

/** Lets the Player be tested against a fake, with no mpv and no sound. */
export interface AudioOutput {
  setVolume(volume: number): void;
  /** A fade covers a cut, so none from a beginning but for the app's songs; onSounding runs as sound starts. */
  resume(fade?: boolean, onSounding?: () => void, durationMs?: number): Promise<void>;
  /** Always fades but for music at its own end, which has nothing to cover, or a notice cut short. */
  pause(fade?: boolean, durationMs?: number): Promise<void>;
  /** Whether the deck is past the opening of what it holds, so starting it is a cut */
  isPartWay(): boolean;
  /** Where the deck is in what it holds, in seconds; null while mpv cannot say */
  position(): number | null;
  captureSongTime(song: SongId): void;
  setLoop(loop: boolean): void;
  hasEnded(): boolean;
  /** Joined part-way it fades in, never for longer than what is left of the track. */
  playFileAt(filePath: string, offsetSec: number, loop?: boolean, fadeLimitMs?: number): Promise<void>;
  /** Puts a library file on the deck, paused at its start */
  loadFile(filePath: string, loop: boolean): void;
  /** Saves no position: only the caller knows whether the one leaving is a song's. */
  loadSong(song: SongId): void;
  loadLastSongTime(song: SongId): Promise<void>;
}
