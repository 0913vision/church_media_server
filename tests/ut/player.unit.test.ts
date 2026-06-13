import { test, describe, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { SongType, MuteState } from '../../server/constants/playerStates.ts';
import type { AudioOutput } from '../../server/hardware/AudioOutput.ts';

// Pure unit tests: no server, no socket, no real MPV. A fake AudioOutput is
// injected so the Player's mute / volume-memory / song-switch logic can be
// asserted directly — this covers the "stay silent while muted" behavior that
// is invisible at the socket level (the console never reports device volume).

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

describe('Player muted behavior (unit)', () => {
  test('volume change while muted stays silent but remembers the level', () => {
    const device = new FakeAudioOutput();
    const player = new Player(device);
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
    const device = new FakeAudioOutput();
    const player = new Player(device);
    player.setMute(MuteState.MUTED);

    await player.changeSong(SongType.FAST);

    assert.strictEqual(player.getCurrentSong(), SongType.FAST);
    assert.strictEqual(device.lastVolume, 0, 'device stays silent through the song change');
    assert.strictEqual(player.getVolume(), 35, 'remembered volume becomes the new song default');
  });

  test('song change while unmuted applies the new song default volume', async () => {
    const device = new FakeAudioOutput();
    const player = new Player(device);

    await player.changeSong(SongType.FAST);

    assert.strictEqual(player.getCurrentSong(), SongType.FAST);
    assert.strictEqual(device.lastVolume, 35);
  });
});
