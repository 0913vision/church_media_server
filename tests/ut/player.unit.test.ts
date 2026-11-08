import { test, describe, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { MuteState, PlaybackState } from '../../server/protocol.ts';
import { INITIAL_PLAYER_CONFIG } from '../../server/constants/playerConfig.ts';
import type { PlayerConfig } from '../../server/constants/playerConfig.ts';
import type { AudioOutput } from '../../server/hardware/AudioOutput.ts';
import type { PersistedState } from '../../server/state/StateStore.ts';

// Note(yoochan.kim): a fake output, since what the device is set to is never reported over the socket.

class FakeAudioOutput implements AudioOutput {
  readonly volumeCalls: number[] = [];
  pauseCalls = 0;

  setVolume(volume: number): void {
    this.volumeCalls.push(volume);
  }
  async resume(_fade?: boolean, onSounding?: () => void): Promise<void> {
    onSounding?.();
  }
  async pause(): Promise<void> {
    this.pauseCalls++;
  }
  isPartWay(): boolean {
    return false;
  }
  position(): number | null {
    return 0;
  }
  captureSongTime(): void {}
  loadSong(): void {}
  async loadLastSongTime(): Promise<void> {}
  async playFileAt(): Promise<void> {}
  loadFile(): void {}
  async cueFileAt(): Promise<void> {}
  queueFile(): void {}
  clearQueue(): void {}
  playingFile(): string | null {
    return null;
  }
  setLoop(): void {}
  hasEnded(): boolean {
    return false;
  }

  get lastVolume(): number | undefined {
    return this.volumeCalls.at(-1);
  }
}

// Note(yoochan.kim): the logger checks LOG_LEVEL at load, so Player is imported once it is set.
type PlayerCtor = typeof import('../../server/player/Player.ts').default;
let Player: PlayerCtor;

before(async () => {
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
  Player = (await import('../../server/player/Player.ts')).default;
});

// Note(yoochan.kim): the songs come from the manifest at boot, so a unit test declares its own.
const CALM = 'calm';
const FERVENT = 'fervent';
const SONG_VOLUMES: Record<string, number> = { [CALM]: 50, [FERVENT]: 35 };
const BASE_CONFIG: PlayerConfig = { ...INITIAL_PLAYER_CONFIG, currentSong: CALM };

function makePlayer(initial: PlayerConfig = BASE_CONFIG) {
  const device = new FakeAudioOutput();
  const saved: PersistedState[] = [];
  const player = new Player(device, { ...initial }, (song) => SONG_VOLUMES[song] ?? 50, (s: PersistedState) => saved.push(s));
  return { device, saved, player };
}

describe('Player muted behavior (unit)', () => {
  test('volume change while muted stays silent but remembers the level', () => {
    const { device, player } = makePlayer();
    assert.strictEqual(device.lastVolume, 53, 'constructor applies initial volume');

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

    await player.changeSong(FERVENT);

    assert.strictEqual(player.getCurrentSong(), FERVENT);
    assert.strictEqual(device.lastVolume, 0, 'device stays silent through the song change');
    assert.strictEqual(player.getVolume(), 35, 'remembered volume becomes the new song default');
  });

  test('song change while unmuted applies the new song default volume', async () => {
    const { device, player } = makePlayer();

    await player.changeSong(FERVENT);

    assert.strictEqual(player.getCurrentSong(), FERVENT);
    assert.strictEqual(device.lastVolume, 35);
  });
});

describe('Player persistence (unit)', () => {
  test('persists preferences on volume, mute, and song changes', async () => {
    const { saved, player } = makePlayer();

    player.setVolume(42);
    assert.deepStrictEqual(saved.at(-1), { serverVolume: 42, muted: MuteState.UNMUTED, currentSong: CALM });

    player.setMute(MuteState.MUTED);
    assert.deepStrictEqual(saved.at(-1), { serverVolume: 42, muted: MuteState.MUTED, currentSong: CALM });

    await player.changeSong(FERVENT);
    assert.deepStrictEqual(saved.at(-1), { serverVolume: 35, muted: MuteState.MUTED, currentSong: FERVENT });
  });

  test('restores persisted preferences but boots silent when muted', () => {
    const restored: PlayerConfig = {
      serverVolume: 70,
      muted: MuteState.MUTED,
      currentSong: FERVENT,
      state: PlaybackState.PAUSED
    };
    const { device, player } = makePlayer(restored);

    assert.strictEqual(player.getVolume(), 70);
    assert.strictEqual(player.getCurrentSong(), FERVENT);
    assert.strictEqual(player.isMuted(), true);
    assert.strictEqual(device.lastVolume, 0, 'a muted restore must boot the device silent');
  });
});

describe('Player handing the deck over (unit)', () => {
  test('taking the deck fades out what is sounding, unless told not to', async () => {
    const { device, player } = makePlayer();
    await player.play();

    // Note(yoochan.kim): a run passes false between its own tracks; a fade there would skip the next one's opening.
    await player.takeDeck(false);
    assert.strictEqual(device.pauseCalls, 0, 'no fade between a run\'s own tracks');

    await player.play();
    await player.takeDeck(true);
    assert.strictEqual(device.pauseCalls, 1, 'something else on the deck is brought down first');
  });

  test('nothing sounding means nothing to fade either way', async () => {
    const { device, player } = makePlayer();
    await player.takeDeck(true);
    assert.strictEqual(device.pauseCalls, 0);
  });
});
