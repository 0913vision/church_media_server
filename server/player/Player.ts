import { PlaybackState, MuteState } from '../protocol.ts';
import type { DeckSource } from '../protocol.ts';
import type { SongId } from '../constants/songs.ts';
import type { PlayerConfig } from '../constants/playerConfig.ts';
import type { AudioOutput } from '../hardware/AudioOutput.ts';
import type { PersistedState } from '../state/StateStore.ts';
import { dbFromLevel } from '../hardware/loudness.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';

class Player {
  private state: PlayerConfig;
  /** True while a library track occupies the deck rather than a song */
  private trackMode = false;
  private trackId = '';
  /** What the device is set to right now, mute aside. See getVolume. */
  private liveVolume: number;
  /** Note(yoochan.kim): the panel's songs run under a service without ending, so this resets when the gate opens. */
  private loop = true;

  /** songVolumeOf is asked each time rather than held, so a level someone adjusts applies at the next selection. */
  constructor(
    private readonly device: AudioOutput,
    initialConfig: PlayerConfig,
    private readonly songVolumeOf: (song: SongId) => number,
    private readonly persist: (state: PersistedState) => void
  ) {
    this.state = { ...initialConfig };
    this.liveVolume = this.state.serverVolume;
    this.device.setVolume(this.isMuted() ? 0 : this.state.serverVolume);
  }

  /** Enough of the deck for a log line to tell afterwards what the room heard. */
  private where(): Record<string, string> {
    const at = this.device.position();
    return {
      deck: this.trackMode ? `track ${this.trackId}` : `song ${this.state.currentSong}`,
      at: at === null ? 'unknown' : `${at.toFixed(1)}s`,
      level: this.levelText(),
    };
  }

  private levelText(): string {
    return this.isMuted()
      ? `muted (${this.liveVolume})`
      : `${this.liveVolume} (${dbFromLevel(this.liveVolume).toFixed(1)} dB)`;
  }

  /** No play/pause: a restart always comes back paused. */
  private snapshot(): PersistedState {
    return {
      serverVolume: this.state.serverVolume,
      muted: this.state.muted,
      currentSong: this.state.currentSong
    };
  }

  // --- volume ---
  /** What is sounding, not what the user set: a flow's or an admin's track plays at its own level meanwhile. */
  getVolume(): number {
    return this.liveVolume;
  }

  /** The level the user's own song comes back to. */
  getUserVolume(): number {
    return this.state.serverVolume;
  }

  setVolume(volume: number): void {
    this.state.serverVolume = volume;
    this.liveVolume = volume;
    this.device.setVolume(this.isMuted() ? 0 : volume);
    this.persist(this.snapshot());
  }

  // --- state ---
  getState(): PlaybackState {
    return this.state.state;
  }

  /** `fadeFromStart`: the app's own songs always fade; onSounding fires as sound starts, not when the fade ends. */
  async play({ onSounding, fadeFromStart = false }: { onSounding?: () => void; fadeFromStart?: boolean } = {}): Promise<void> {
    const fade = fadeFromStart || this.device.isPartWay();
    log.info('player', null, 'Play', { ...this.where(), fade: fade ? 'in' : 'none' });
    try {
      await this.device.resume(fade, () => {
        this.state.state = PlaybackState.PLAYING;
        onSounding?.();
      });
    } catch (error) {
      log.error('player', null, 'Failed to play audio', { error: errorMessage(error) });
      throw error;
    }
    this.state.state = PlaybackState.PLAYING;
  }

  async pause(): Promise<void> {
    log.info('player', null, 'Pause', { ...this.where(), fade: 'out' });
    try {
      await this.device.pause();
    } catch (error) {
      log.error('player', null, 'Failed to pause audio', { error: errorMessage(error) });
      throw error;
    }
    this.state.state = PlaybackState.PAUSED;
  }

  /** No fade: a run's notice cut short must stop at once, since a count fading away is still heard as a count. */
  async cut(): Promise<void> {
    if (!this.isPlaying()) return;
    log.info('player', null, 'Cut', { ...this.where(), fade: 'none' });
    try {
      await this.device.pause(false);
    } catch (error) {
      log.error('player', null, 'Failed to cut audio', { error: errorMessage(error) });
      throw error;
    }
    this.state.state = PlaybackState.PAUSED;
  }

  // --- mute ---
  getMute(): MuteState {
    return this.state.muted;
  }

  setMute(muted: MuteState): void {
    this.state.muted = muted;
    if (muted === MuteState.MUTED) {
      this.device.setVolume(0);
    } else {
      // Note(yoochan.kim): what was sounding, not the user's setting, while a flow or an admin's track has the deck.
      this.device.setVolume(this.liveVolume);
    }
    this.persist(this.snapshot());
  }

  // --- song ---
  getCurrentSong(): SongId {
    return this.state.currentSong;
  }

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
      // Note(yoochan.kim): while a track has the deck the live position is the track's, not the song's.
      if (!this.trackMode) {
        this.device.captureSongTime(currentSong);
      }
      this.trackMode = false;
      this.device.loadSong(newSong);
    } catch (error) {
      log.error('player', null, 'Failed to change song', { currentSong, newSong, error: errorMessage(error) });
      throw error;
    }

    const newVolume = this.songVolumeOf(newSong);

    try {
      this.device.setVolume(this.isMuted() ? 0 : newVolume);
    } catch (error) {
      log.error('player', null, 'Failed to set volume during song change', { newVolume, error: errorMessage(error) });
      throw error;
    }

    this.state.currentSong = newSong;
    this.state.state = PlaybackState.PAUSED;
    this.state.serverVolume = newVolume;
    this.liveVolume = newVolume;
    this.persist(this.snapshot());

    try {
      await this.device.loadLastSongTime(newSong);
    } catch (error) {
      log.error('player', null, 'Failed to load last song time', { newSong, error: errorMessage(error) });
      throw error;
    }
    log.info('player', null, 'Song changed', {
      from: currentSong,
      ...this.where(),
      fade: wasPlaying ? 'out' : 'none',
    });
  }

  /** Apart from playTrackAt: a fade takes seconds, and the caller works out where its timeline is after it. */
  async takeDeck(fade = true): Promise<void> {
    // Note(yoochan.kim): captured once, since a track's position must never be written into a song's memory.
    if (!this.trackMode) {
      log.info('player', null, 'Deck taken from the song', {
        ...this.where(),
        fade: fade && this.isPlaying() ? 'out' : 'none',
      });
      this.device.captureSongTime(this.state.currentSong);
      this.trackMode = true;
    }
    if (fade && this.isPlaying()) {
      try {
        await this.device.pause();
      } catch (error) {
        log.error('player', null, 'Failed to fade out before a flow took the deck', { error: errorMessage(error) });
        throw error;
      }
      this.state.state = PlaybackState.PAUSED;
    }
  }

  /** Leaves serverVolume alone so restoreSong brings the user's level back; muted stays silent even for a flow. */
  async playTrackAt(
    track: { id: string; file: string }, offsetSec: number, volume: number, loop = false, fadeLimitMs?: number,
  ): Promise<void> {
    try {
      // Note(yoochan.kim): the caller has taken the deck; a fade here would put seconds between a run's tracks.
      await this.takeDeck(false);
      this.device.setVolume(this.isMuted() ? 0 : volume);
      this.liveVolume = volume;
      await this.device.playFileAt(track.file, offsetSec, loop, fadeLimitMs);
    } catch (error) {
      log.error('player', null, 'Failed to play track', { track: track.id, offsetSec, volume, error: errorMessage(error) });
      throw error;
    }
    this.trackId = track.id;
    this.state.state = PlaybackState.PLAYING;
  }

  /** Loaded paused so starting it on its second is only an unpause; the caller has already taken the deck. */
  async cueTrack(track: { id: string; file: string }, volume: number): Promise<void> {
    try {
      await this.takeDeck(false);
      this.device.setVolume(this.isMuted() ? 0 : volume);
      this.liveVolume = volume;
      this.device.loadFile(track.file, false);
    } catch (error) {
      log.error('player', null, 'Failed to cue track', { track: track.id, volume, error: errorMessage(error) });
      throw error;
    }
    this.trackId = track.id;
    this.state.state = PlaybackState.PAUSED;
  }

  /** Note(yoochan.kim): chosen, not started, like picking a panel song: pressing a name says which, not go. */
  async selectTrack(track: { id: string; file: string }, volume: number, loop: boolean): Promise<void> {
    try {
      await this.takeDeck();
      this.device.setVolume(this.isMuted() ? 0 : volume);
      this.liveVolume = volume;
      this.device.loadFile(track.file, loop);
    } catch (error) {
      log.error('player', null, 'Failed to select track', { track: track.id, error: errorMessage(error) });
      throw error;
    }
    this.trackId = track.id;
    this.state.state = PlaybackState.PAUSED;
    // Note(yoochan.kim): no position: the file is still loading and mpv would report the previous one's.
    log.info('player', null, 'Track put on the deck', { deck: `track ${track.id}`, level: this.levelText(), loop });
  }

  getDeck(): DeckSource {
    return this.trackMode ? { source: 'track', id: this.trackId } : { source: 'song' };
  }

  async restoreSong(fade = true): Promise<void> {
    if (!this.trackMode) return;

    const wasPlaying = this.isPlaying();
    try {
      if (wasPlaying) {
        // Note(yoochan.kim): music at its own end has no cut to cover, and fading it costs seconds of silence.
        await this.device.pause(fade);
      }
      // Note(yoochan.kim): the flow played at its own level; the user's comes back with their song.
      this.device.setVolume(this.isMuted() ? 0 : this.state.serverVolume);
      this.liveVolume = this.state.serverVolume;
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
    log.info('player', null, 'Deck back to the song', {
      ...this.where(),
      fade: wasPlaying && fade ? 'out' : 'none',
    });
  }

  getLoop(): boolean {
    return this.loop;
  }

  /** Never true for the panel's songs, which loop. */
  hasEnded(): boolean {
    return this.device.hasEnded();
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
    this.device.setLoop(loop);
  }

  // --- utility ---

  isPlaying(): boolean {
    return this.state.state === PlaybackState.PLAYING;
  }

  isMuted(): boolean {
    return this.state.muted === MuteState.MUTED;
  }
}

export default Player;
