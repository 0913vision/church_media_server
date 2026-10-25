import { test, describe, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { MuteState, PlaybackState } from '../../server/protocol.ts';
import type MpvClient from '../../server/hardware/MpvClient.ts';
import { dbFromLevel, fadeInDb, fadeOutDb, mpvVolumeFromDb } from '../../server/hardware/loudness.ts';

// Note(yoochan.kim): a stand-in for mpv that only writes down what it was told, so
// nothing here can make a sound. The device and player read env-backed config
// and log at module load, so they are loaded once that is set.
type PlayerCtor = typeof import('../../server/player/Player.ts').default;
type DeviceCtor = typeof import('../../server/hardware/AudioDevice.ts').default;
let Player: PlayerCtor;
let AudioDevice: DeviceCtor;
let FADE_MS: number;
let STEP_MS: number;

before(async () => {
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
  process.env.CONSOLE_MODE = process.env.CONSOLE_MODE ?? 'MOCK';
  process.env.MPV_LIBRARY_PATH = process.env.MPV_LIBRARY_PATH ?? '/opt/homebrew/lib/libmpv.dylib';
  Player = (await import('../../server/player/Player.ts')).default;
  AudioDevice = (await import('../../server/hardware/AudioDevice.ts')).default;
  ({ FADE_MS, FADE_STEP_MS: STEP_MS } = (await import('../../server/constants/deviceConfig.ts')).DEVICE_CONFIG);
});

/** The deck's level in deck(), 0–100. */
const LEVEL = 40;

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

function deck(): { mpv: FakeMpv; device: InstanceType<DeviceCtor>; player: InstanceType<PlayerCtor> } {
  const mpv = new FakeMpv();
  const device = new AudioDevice(mpv as unknown as MpvClient, 'calm', { calm: '/audio/calm.mp3' });
  const player = new Player(
    device,
    { serverVolume: LEVEL, muted: MuteState.UNMUTED, state: PlaybackState.PAUSED, currentSong: 'calm' },
    () => 50,
    () => {},
  );
  return { mpv, device, player };
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
    assert.deepStrictEqual(mpv.calls.filter((call) => call.startsWith('volume=')), [`volume=${mpvVolumeFromDb(dbFromLevel(60))}`],
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

/** Each volume mpv was told, read back as decibels under the deck's level. */
function fadeDb(calls: string[]): number[] {
  return calls.filter((call) => call.startsWith('volume='))
    .map((call) => 60 * Math.log10(Number(call.slice('volume='.length)) / 100) - dbFromLevel(LEVEL));
}

const near = (actual: number, expected: number, what: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: ${actual.toFixed(2)} dB, want ${expected.toFixed(2)}`);
};

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

  test('picked up part-way it fades in: up through the silent bottom quickly, then the same dB every moment', async () => {
    const { mpv, player } = deck();
    mpv.props['playback-time'] = '42';
    mpv.calls = [];
    let soundingAt = -1;
    const pressed = Date.now();
    await player.play(() => { soundingAt = Date.now() - pressed; });
    const done = Date.now() - pressed;

    assert.ok(soundingAt >= 0 && soundingAt < 50, `told it sounds after ${soundingAt}ms, not when the fade ended`);
    assert.ok(done > FADE_MS - 200, `the fade still ran (${done}ms)`);
    assert.strictEqual(mpv.calls[1], 'pause=no', 'set quiet before it is let go');
    const curve = fadeDb(mpv.calls);
    assert.strictEqual(curve.length, FADE_MS / STEP_MS + 1);
    curve.forEach((db, i) => near(db, fadeInDb(i * STEP_MS, FADE_MS), `${i * STEP_MS}ms`));
    // Heard 300ms after the press; on the old curve it was all but silent for half a second.
    near(curve[300 / STEP_MS]!, -40, 'at 300ms');
  });

  test('a fade can be any length, the curve stretched to it', async () => {
    const { mpv, device } = deck();
    mpv.props['playback-time'] = '42';
    mpv.calls = [];
    const pressed = Date.now();
    await device.resume(true, undefined, 1000);
    const done = Date.now() - pressed;

    assert.ok(done >= 950 && done < 1500, `a one-second fade took ${done}ms`);
    const curve = fadeDb(mpv.calls);
    curve.forEach((db, i) => near(db, fadeInDb(i * STEP_MS, 1000), `${i * STEP_MS}ms`));
    near(curve[100 / STEP_MS]!, -40, 'heard after a tenth of it');
  });

  test('pausing fades out the same way backwards, then puts the level back for the next play', async () => {
    const { mpv, player } = deck();
    mpv.props['playback-time'] = '42';
    await player.play();
    mpv.calls = [];
    await player.pause();

    const paused = mpv.calls.indexOf('pause=yes');
    const curve = fadeDb(mpv.calls.slice(0, paused));
    curve.forEach((db, i) => near(db, fadeOutDb((i + 1) * STEP_MS, FADE_MS), `${(i + 1) * STEP_MS}ms`));
    assert.ok(curve.at(-1)! < -70, `out of hearing before it stops (${curve.at(-1)!.toFixed(1)} dB)`);
    near(fadeDb(mpv.calls.slice(paused))[0]!, 0, 'the level after');
  });
});
