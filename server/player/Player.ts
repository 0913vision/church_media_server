import { PlaybackState, MuteState } from '../protocol.ts';
import type { SongId } from '../constants/songs.ts';
import type { PlayerConfig } from '../constants/playerConfig.ts';
import type { AudioOutput } from '../hardware/AudioOutput.ts';
import type { PersistedState } from '../state/StateStore.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

/**
 * High-level Player class that abstracts hardware control and manages player state
 */
class Player {
  private state: PlayerConfig;
  /** True while a scheduled library track occupies the deck (not a song) */
  private trackMode = false;

  /**
   * @param device - Audio output (injected by the composition root)
   * @param initialConfig - Starting state (defaults, or restored preferences
   *   with state forced to PAUSED by the composition root)
   * @param songVolumes - The volume each song returns to, from the manifest
   * @param persist - Called with the preferences snapshot whenever they change,
   *   so they survive a restart / reboot
   */
  constructor(
    private readonly device: AudioOutput,
    initialConfig: PlayerConfig,
    private readonly songVolumes: Record<SongId, number>,
    private readonly persist: (state: PersistedState) => void
  ) {
    this.state = { ...initialConfig };
    // Note(yoochan.kim): Initialize hardware with the starting volume (silent if muted)
    this.device.setVolume(this.isMuted() ? 0 : this.state.serverVolume);
  }

  /** Snapshot of the persisted preferences (no play/pause state) */
  private snapshot(): PersistedState {
    return {
      serverVolume: this.state.serverVolume,
      muted: this.state.muted,
      currentSong: this.state.currentSong
    };
  }

  // Note(yoochan.kim): Volume methods
  /**
   * Gets the current volume level
   * @returns Current volume (0-100)
   */
  getVolume(): number {
    return this.state.serverVolume;
  }

  /**
   * Sets the volume level and updates hardware.
   * While muted, the device stays silent — only the remembered volume changes.
   * @param volume - Volume level (0-100)
   */
  setVolume(volume: number): void {
    this.state.serverVolume = volume;
    this.device.setVolume(this.isMuted() ? 0 : volume);
    this.persist(this.snapshot());
  }

  // Note(yoochan.kim): State methods
  /**
   * Gets the current playback state
   */
  getState(): PlaybackState {
    return this.state.state;
  }

  /**
   * Plays the audio and updates state
   */
  async play(): Promise<void> {
    try {
      await this.device.resume();
    } catch (error) {
      log.error('player', null, 'Failed to play audio', { error: errorMessage(error) });
      throw error;
    }
    this.state.state = PlaybackState.PLAYING;
  }

  /**
   * Pauses the audio and updates state
   */
  async pause(): Promise<void> {
    try {
      await this.device.pause();
    } catch (error) {
      log.error('player', null, 'Failed to pause audio', { error: errorMessage(error) });
      throw error;
    }
    this.state.state = PlaybackState.PAUSED;
  }

  // Note(yoochan.kim): Mute methods
  /**
   * Gets the current mute status
   */
  getMute(): MuteState {
    return this.state.muted;
  }

  /**
   * Sets mute status and updates hardware volume
   */
  setMute(muted: MuteState): void {
    this.state.muted = muted;
    if (muted === MuteState.MUTED) {
      this.device.setVolume(0);
    } else {
      this.device.setVolume(this.state.serverVolume);
    }
    this.persist(this.snapshot());
  }

  // Note(yoochan.kim): Song methods
  /**
   * Gets the currently selected song
   */
  getCurrentSong(): SongId {
    return this.state.currentSong;
  }

  /**
   * Changes song, updates volume, and handles hardware switching.
   * The player's own state decides which song is current; while muted, the
   * device stays silent and only the remembered volume moves to the new
   * song's default.
   * @param newSong - Song to switch to
   */
  async changeSong(newSong: SongId): Promise<void> {
    const currentSong = this.state.currentSong;
    const wasPlaying = this.isPlaying();

    if (wasPlaying) {
      try {
        await this.device.pause();
      } catch (error) {
        log.error('player', null, 'Failed to pause during song change', { error: errorMessage(error) });
        throw error;
      }
    }

    try {
      // Note(yoochan.kim): While a scheduled track occupies the deck, the live position belongs
      // to the track — saving it would corrupt the song's time memory.
      if (!this.trackMode) {
        this.device.captureSongTime(currentSong);
      }
      this.trackMode = false;
      this.device.loadSong(newSong);
    } catch (error) {
      log.error('player', null, 'Failed to change song', { currentSong, newSong, error: errorMessage(error) });
      throw error;
    }

    const newVolume = this.songVolumes[newSong]!;

    try {
      this.device.setVolume(this.isMuted() ? 0 : newVolume);
    } catch (error) {
      log.error('player', null, 'Failed to set volume during song change', { newVolume, error: errorMessage(error) });
      throw error;
    }

    this.state.currentSong = newSong;
    this.state.state = PlaybackState.PAUSED;
    this.state.serverVolume = newVolume;
    this.persist(this.snapshot());

    try {
      await this.device.loadLastSongTime(newSong);
    } catch (error) {
      log.error('player', null, 'Failed to load last song time', { newSong, error: errorMessage(error) });
      throw error;
    }
  }

  /**
   * Plays a library track from an offset (scheduled flows). The current
   * song's position is captured once when the deck is first taken over, so
   * restoreSong() can return exactly where the user left off.
   */
  /**
   * Hands the deck to a scheduled flow: remembers where the user's song was,
   * and fades out if it is sounding, the same way pausing does.
   *
   * Kept separate from playTrackAt because the fade takes seconds, and a flow
   * has to work out where its timeline is *after* that, not before — otherwise
   * it seeks to where the music was when the fade began.
   */
  async takeDeck(): Promise<void> {
    if (this.trackMode) return;

    this.device.captureSongTime(this.state.currentSong);
    this.trackMode = true;
    if (this.isPlaying()) {
      try {
        await this.device.pause();
      } catch (error) {
        log.error('player', null, 'Failed to fade out before a flow took the deck', { error: errorMessage(error) });
        throw error;
      }
      this.state.state = PlaybackState.PAUSED;
    }
  }

  async playTrackAt(filePath: string, offsetSec: number): Promise<void> {
    try {
      await this.takeDeck();
      await this.device.playFileAt(filePath, offsetSec);
    } catch (error) {
      log.error('player', null, 'Failed to play track', { filePath, offsetSec, error: errorMessage(error) });
      throw error;
    }
    this.state.state = PlaybackState.PLAYING;
  }

  /**
   * Returns the deck to the two-song system after a scheduled flow: fades out
   * if sounding, reloads the current song at its remembered position, paused.
   * No-op when no track has taken the deck.
   */
  async restoreSong(): Promise<void> {
    if (!this.trackMode) return;

    try {
      if (this.isPlaying()) {
        await this.device.pause();
      }
      this.device.loadSong(this.state.currentSong);
      await this.device.loadLastSongTime(this.state.currentSong);
    } catch (error) {
      log.error('player', null, 'Failed to restore song after track playback', { error: errorMessage(error) });
      throw error;
    }
    this.state.state = PlaybackState.PAUSED;
    this.trackMode = false;
  }

  // Note(yoochan.kim): Utility methods

  /**
   * Checks if the player is currently playing
   */
  isPlaying(): boolean {
    return this.state.state === PlaybackState.PLAYING;
  }

  /**
   * Checks if the player is currently muted
   */
  isMuted(): boolean {
    return this.state.muted === MuteState.MUTED;
  }
}

export default Player;
