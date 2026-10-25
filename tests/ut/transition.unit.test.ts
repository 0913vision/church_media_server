import { test, describe, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { MuteState, PlaybackState } from '../../server/protocol.ts';
import type MpvClient from '../../server/hardware/MpvClient.ts';

// Note(yoochan.kim): a stand-in for mpv that only writes down what it was told, so
// nothing here can make a sound. The device and player read env-backed config
// and log at module load, so they are loaded once that is set.
type PlayerCtor = typeof import('../../server/player/Player.ts').default;
type DeviceCtor = typeof import('../../server/hardware/AudioDevice.ts').default;
let Player: PlayerCtor;
let AudioDevice: DeviceCtor;

before(async () => {
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
  process.env.CONSOLE_MODE = process.env.CONSOLE_MODE ?? 'MOCK';
  process.env.MPV_LIBRARY_PATH = process.env.MPV_LIBRARY_PATH ?? '/opt/homebrew/lib/libmpv.dylib';
  Player = (await import('../../server/player/Player.ts')).default;
  AudioDevice = (await import('../../server/hardware/AudioDevice.ts')).default;
});

class FakeMpv {
  calls: string[] = [];
  readonly props: Record<string, string> = { volume: '50', 'playback-time': '0', 'idle-active': 'no', pause: 'yes' };

  setProperty(property: string, value: string): void {
    this.calls.push(`${property}=${value}`);
    this.props[property] = value;
  }

  getProperty(property: string): string | null {
    return this.props[property] ?? null;
  }

  executeCommand(command: (string | null)[]): void {
    this.calls.push(command.filter((part) => part !== null).join(' '));
  }
}

function deck(): { mpv: FakeMpv; player: InstanceType<PlayerCtor> } {
  const mpv = new FakeMpv();
  const device = new AudioDevice(mpv as unknown as MpvClient, 'calm', { calm: '/audio/calm.mp3' });
  const player = new Player(
    device,
    { serverVolume: 40, muted: MuteState.UNMUTED, state: PlaybackState.PAUSED, currentSong: 'calm' },
    () => 50,
    () => {},
  );
  return { mpv, player };
}

describe('A run moving from one of its tracks to the next', () => {
  test('starts the next at once, from its beginning, with nothing faded between', async () => {
    const { mpv, player } = deck();
    await player.takeDeck(true);
    await player.playTrackAt({ id: 'first', file: '/audio/first.mp3' }, 0, 60);
    mpv.calls = [];

    // Note(yoochan.kim): what FlowRunner does at a boundary between its own tracks. The
    // timer fires a few milliseconds late, which is not a seek.
    const boundary = Date.now();
    await player.takeDeck(false);
    await player.playTrackAt({ id: 'second', file: '/audio/second.mp3' }, 0.004, 60);
    const took = Date.now() - boundary;

    assert.ok(took < 100, `the next track sounded ${took}ms after its boundary`);
    assert.ok(!mpv.calls.some((call) => call.startsWith('playback-time=')), 'a start on time does not seek');
    assert.deepStrictEqual(mpv.calls.filter((call) => call.startsWith('volume=')), ['volume=60'],
      'the level is set once, with no fade out or in');
    assert.ok(mpv.calls.includes('loadfile /audio/second.mp3'));
    assert.strictEqual(mpv.calls.at(-1), 'pause=no');
  });

  test('a track joined part-way is sought and faded in, which is what the fade is for', async () => {
    const { mpv, player } = deck();
    await player.takeDeck(true);
    await player.playTrackAt({ id: 'late', file: '/audio/late.mp3' }, 12, 60);

    assert.ok(mpv.calls.includes('playback-time=12'));
    const levels = mpv.calls.filter((call) => call.startsWith('volume='));
    assert.ok(levels.length > 10, `faded in over ${levels.length} steps`);
  });
});

/** The volumes a fade set after it started from silence, as numbers. */
function fadeLevels(calls: string[]): number[] {
  const volumes = calls.filter((call) => call.startsWith('volume=')).map((call) => Number(call.slice('volume='.length)));
  return volumes.slice(volumes.indexOf(0) + 1);
}

describe('Pressing play', () => {
  test('a song at its beginning sounds at once, with no fade', async () => {
    const { mpv, player } = deck();
    mpv.calls = [];
    let soundingAt = -1;
    const pressed = Date.now();
    await player.play(() => { soundingAt = Date.now() - pressed; });

    assert.ok(Date.now() - pressed < 100, 'play returned without waiting on a fade');
    assert.ok(soundingAt >= 0 && soundingAt < 50, `told it sounds after ${soundingAt}ms`);
    assert.ok(!mpv.calls.some((call) => call.startsWith('volume=')), 'nothing faded');
    assert.deepStrictEqual(mpv.calls, ['pause=no']);
  });

  test('picked up part-way it fades in, the sound rising on the quarter sine from the press', async () => {
    const { mpv, player } = deck();
    mpv.props['playback-time'] = '42';
    mpv.calls = [];
    let soundingAt = -1;
    const pressed = Date.now();
    await player.play(() => { soundingAt = Date.now() - pressed; });
    const done = Date.now() - pressed;

    assert.ok(soundingAt >= 0 && soundingAt < 50, `told it sounds after ${soundingAt}ms, not when the fade ended`);
    assert.ok(done > 2500, `the fade still ran (${done}ms)`);
    const levels = fadeLevels(mpv.calls);
    const full = levels.at(-1)!;
    // mpv's volume is cubic: the sound is the cube of the volume's share of full.
    levels.forEach((level, i) => {
      const sound = (level / full) ** 3;
      const want = Math.sin((Math.PI / 2) * (i / (levels.length - 1)));
      assert.ok(Math.abs(sound - want) < 1e-6, `step ${i}: sound ${sound.toFixed(4)}, want ${want.toFixed(4)}`);
    });
    // 300ms after the press the music is 16 dB under full, where it used to be 48 dB under.
    assert.ok(20 * Math.log10((levels[3]! / full) ** 3) > -17);
  });

  test('pausing fades the sound out on the quarter cosine', async () => {
    const { mpv, player } = deck();
    mpv.props['playback-time'] = '42';
    await player.play();
    mpv.calls = [];
    await player.pause();

    const volumes = mpv.calls.filter((call) => call.startsWith('volume=')).map((call) => Number(call.slice('volume='.length)));
    const steps = volumes.slice(0, -1);
    const full = steps[0]!;
    steps.forEach((level, i) => {
      const sound = (level / full) ** 3;
      const want = Math.cos((Math.PI / 2) * (i / (steps.length - 1)));
      assert.ok(Math.abs(sound - want) < 1e-6, `step ${i}: sound ${sound.toFixed(4)}, want ${want.toFixed(4)}`);
    });
    assert.ok(mpv.calls.includes('pause=yes'));
  });
});
