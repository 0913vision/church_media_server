import { test, describe, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { SongType, MuteState, PlayerState } from '../../server/constants/playerStates.ts';
import { INITIAL_PLAYER_CONFIG } from '../../server/constants/playerConfig.ts';
import type { PlayerConfig } from '../../server/constants/playerConfig.ts';
import type { AudioOutput } from '../../server/hardware/AudioOutput.ts';
import type { PersistedState } from '../../server/state/StateStore.ts';

// Pure unit tests: no server, no socket, no real MPV. A fake AudioOutput is
// injected so the Player's mute / volume-memory / song-switch logic, and its
// persistence + restore behavior, can be asserted directly — behavior that is
// invisible at the socket level (the console never reports device volume).

/** Records every volume the Player pushes to the output. */
class FakeAudioOutput implements AudioOutput {
  readonly volumeCalls: number[] = [];

  setVolume(volume: number): void {
    this.volumeCalls.push(volume);
  }
  async resume(): Promise<void> {}
  async pause(): Promise<void> {}
  changeSong(): void {}
  async loadLastSongTime(): Promise<void> {}

  get lastVolume(): number | undefined {
    return this.volumeCalls.at(-1);
  }
}

// Player imports the logger, which validates LOG_LEVEL at module load, so set
// it before importing and load Player dynamically.
type PlayerCtor = typeof import('../../server/player/Player.ts').default;
let Player: PlayerCtor;

before(async () => {
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
  Player = (await import('../../server/player/Player.ts')).default;
});

/** Builds a Player with a fresh fake device and a recording persist spy. */
function makePlayer(initial: PlayerConfig = INITIAL_PLAYER_CONFIG) {
  const device = new FakeAudioOutput();
  const saved: PersistedState[] = [];
  const player = new Player(device, { ...initial }, (s) => saved.push(s));
  return { device, saved, player };
}

describe('Player muted behavior (unit)', () => {
  test('volume change while muted stays silent but remembers the level', () => {
    const { device, player } = makePlayer();
    assert.strictEqual(device.lastVolume, 50, 'constructor applies initial volume');

    player.setMute(MuteState.MUTED);
    assert.strictEqual(device.lastVolume, 0, 'muting drops device to 0');

    player.setVolume(70);
    assert.strictEqual(device.lastVolume, 0, 'device stays silent while muted');
    assert.strictEqual(player.getVolume(), 70, 'remembered volume still updates');

    player.setMute(MuteState.UNMUTED);
    assert.strictEqual(device.lastVolume, 70, 'unmuting restores the remembered volume');
  });

  test('song change while muted keeps the device silent', async () => {
    const { device, player } = makePlayer();
    player.setMute(MuteState.MUTED);

    await player.changeSong(SongType.FAST);

    assert.strictEqual(player.getCurrentSong(), SongType.FAST);
    assert.strictEqual(device.lastVolume, 0, 'device stays silent through the song change');
    assert.strictEqual(player.getVolume(), 35, 'remembered volume becomes the new song default');
  });

  test('song change while unmuted applies the new song default volume', async () => {
    const { device, player } = makePlayer();

    await player.changeSong(SongType.FAST);

    assert.strictEqual(player.getCurrentSong(), SongType.FAST);
    assert.strictEqual(device.lastVolume, 35);
  });
});

describe('Player persistence (unit)', () => {
  test('persists preferences on volume, mute, and song changes', async () => {
    const { saved, player } = makePlayer();

    player.setVolume(42);
    assert.deepStrictEqual(saved.at(-1), { serverVolume: 42, muted: MuteState.UNMUTED, currentSong: SongType.SLOW });

    player.setMute(MuteState.MUTED);
    assert.deepStrictEqual(saved.at(-1), { serverVolume: 42, muted: MuteState.MUTED, currentSong: SongType.SLOW });

    await player.changeSong(SongType.FAST);
    assert.deepStrictEqual(saved.at(-1), { serverVolume: 35, muted: MuteState.MUTED, currentSong: SongType.FAST });
  });

  test('restores persisted preferences but boots silent when muted', () => {
    const restored: PlayerConfig = {
      serverVolume: 70,
      muted: MuteState.MUTED,
      currentSong: SongType.FAST,
      state: PlayerState.PAUSED
    };
    const { device, player } = makePlayer(restored);

    assert.strictEqual(player.getVolume(), 70);
    assert.strictEqual(player.getCurrentSong(), SongType.FAST);
    assert.strictEqual(player.isMuted(), true);
    assert.strictEqual(device.lastVolume, 0, 'a muted restore must boot the device silent');
  });
});
