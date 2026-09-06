import { PlaybackState, MuteState } from '../protocol.ts';
import type { DeckSource } from '../protocol.ts';
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
  private trackId = '';
  /**
   * Note(yoochan.kim): always on unless the gate is held. The panel's songs are meant
   * to run under a service without ending, so this resets when the gate opens.
   */
  private loop = true;

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

  /**
   * Plays a scheduled track at the level its flow asked for.
   *
   * The user's own volume is left untouched in state: a flow borrows the deck
   * and hands it back, so restoreSong puts their level back with their song.
   * Muted still means silent — a flow may take the deck, but not the decision
   * to make noise.
   */
  async playTrackAt(track: { id: string; file: string }, offsetSec: number, volume: number, loop = false): Promise<void> {
    try {
      await this.takeDeck();
      this.device.setVolume(this.isMuted() ? 0 : volume);
      await this.device.playFileAt(track.file, offsetSec, loop);
    } catch (error) {
      log.error('player', null, 'Failed to play track', { track: track.id, offsetSec, volume, error: errorMessage(error) });
      throw error;
    }
    this.trackId = track.id;
    this.state.state = PlaybackState.PLAYING;
  }

  /** What has the deck: the panel's own song, or a library track an admin put on. */
  getDeck(): DeckSource {
    return this.trackMode ? { source: 'track', id: this.trackId } : { source: 'song' };
  }

  /**
   * Returns the deck to the two-song system after a scheduled flow: fades out
   * if sounding, reloads the current song at its remembered position, paused.
   * No-op when no track has taken the deck.
   */
  async restoreSong(fade = true): Promise<void> {
    if (!this.trackMode) return;

    try {
      if (this.isPlaying()) {
        // Note(yoochan.kim): a fade covers a cut. Music that has just reached its
        // own end has nothing to cover, and fading it costs seconds of silence.
        await this.device.pause(fade);
      }
      // Note(yoochan.kim): the flow played at its own level; the user's comes
      // back with their song
      this.device.setVolume(this.isMuted() ? 0 : this.state.serverVolume);
      this.device.loadSong(this.state.currentSong);
      await this.device.loadLastSongTime(this.state.currentSong);
    } catch (error) {
      log.error('player', null, 'Failed to restore song after track playback', { error: errorMessage(error) });
      throw error;
    }
    this.state.state = PlaybackState.PAUSED;
    this.trackMode = false;
    this.trackId = '';
    this.loop = true;
  }

  getLoop(): boolean {
    return this.loop;
  }

  /** Whether what is on the deck has run out. False for the two-song deck, which loops. */
  hasEnded(): boolean {
    return this.device.hasEnded();
  }

  /** Sets whether what is on the deck repeats, and applies it to what is playing now. */
  setLoop(loop: boolean): void {
    this.loop = loop;
    this.device.setLoop(loop);
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
