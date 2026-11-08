import { test, describe, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { MuteState, PlaybackState } from '../../server/protocol.ts';
import type MpvClient from '../../server/hardware/MpvClient.ts';
import { dbFromLevel, fadeInDb, fadeOutDb, mpvVolumeFromDb } from '../../server/hardware/loudness.ts';

// Note(yoochan.kim): the device and player read env-backed config at module load, so they are loaded once it is set.
type PlayerCtor = typeof import('../../server/player/Player.ts').default;
type DeviceCtor = typeof import('../../server/hardware/AudioDevice.ts').default;
let Player: PlayerCtor;
let AudioDevice: DeviceCtor;
let FADE_IN_MS: number;
let FADE_OUT_MS: number;
let EDGE_DB: number;
let STEP_MS: number;

before(async () => {
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
  process.env.CONSOLE_MODE = process.env.CONSOLE_MODE ?? 'MOCK';
  process.env.MPV_LIBRARY_PATH = process.env.MPV_LIBRARY_PATH ?? '/opt/homebrew/lib/libmpv.dylib';
  Player = (await import('../../server/player/Player.ts')).default;
  AudioDevice = (await import('../../server/hardware/AudioDevice.ts')).default;
  ({ FADE_IN_MS, FADE_OUT_MS, FADE_EDGE_DB: EDGE_DB, FADE_STEP_MS: STEP_MS } = (await import('../../server/constants/deviceConfig.ts')).DEVICE_CONFIG);
});

/** The deck's level in deck(), 0–100. */
const LEVEL = 40;

/** A stand-in for mpv that only writes down what it was told, so nothing here can make a sound. */
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

    // Note(yoochan.kim): what FlowRunner does at a boundary when mpv has not run on into the track it queued.
    const boundary = Date.now();
    await player.takeDeck(false);
    // Note(yoochan.kim): its timer fires a few milliseconds late, which is not a seek.
    await player.playTrackAt({ id: 'second', file: '/audio/second.mp3' }, 0.004, 60);
    const took = Date.now() - boundary;

    assert.ok(took < 100, `the next track sounded ${took}ms after its boundary`);
    assert.ok(!mpv.calls.some((call) => call.startsWith('playback-time=')), 'a start on time does not seek');
    assert.deepStrictEqual(mpv.calls.filter((call) => call.startsWith('volume=')), [`volume=${mpvVolumeFromDb(dbFromLevel(60))}`],
      'the level is set once, with no fade out or in');
    assert.ok(mpv.calls.includes('loadfile /audio/second.mp3'));
    assert.strictEqual(mpv.calls.at(-1), 'pause=no');
  });

  test('a track joined in its last moments fades in no longer than what is left of it', async () => {
    const { mpv, device } = deck();
    mpv.calls = [];
    const started = Date.now();
    await device.playFileAt('/audio/late.mp3', 12, false, 300);
    const took = Date.now() - started;

    assert.ok(took < 600, `the fade in took ${took}ms with 300ms of the track left`);
    assert.ok(mpv.calls.includes('playback-time=12'));
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
  test('a track at its beginning sounds at once, with no fade', async () => {
    const { mpv, player } = deck();
    mpv.calls = [];
    let soundingAt = -1;
    const pressed = Date.now();
    await player.play({ onSounding: () => { soundingAt = Date.now() - pressed; } });

    assert.ok(Date.now() - pressed < 100, 'play returned without waiting on a fade');
    assert.ok(soundingAt >= 0 && soundingAt < 50, `told it sounds after ${soundingAt}ms`);
    assert.ok(!mpv.calls.some((call) => call.startsWith('volume=')), 'nothing faded');
    assert.deepStrictEqual(mpv.calls, ['pause=no']);
  });

  // Note(yoochan.kim): an app song started unfaded from its beginning comes in at full level and startles the room.
  test('one of the app\'s own songs fades in from its very beginning too', async () => {
    const { mpv, player } = deck();
    mpv.calls = [];
    let soundingAt = -1;
    const pressed = Date.now();
    await player.play({ onSounding: () => { soundingAt = Date.now() - pressed; }, fadeFromStart: true });
    const done = Date.now() - pressed;

    assert.ok(soundingAt >= 0 && soundingAt < 50, `told it sounds after ${soundingAt}ms`);
    assert.ok(done > FADE_IN_MS - 200, `the fade ran (${done}ms)`);
    assert.strictEqual(mpv.calls[1], 'pause=no', 'set quiet before it is let go');
    const curve = fadeDb(mpv.calls);
    assert.strictEqual(curve.length, FADE_IN_MS / STEP_MS + 1);
    curve.forEach((db, i) => near(db, fadeInDb(i * STEP_MS, FADE_IN_MS, EDGE_DB), `${i * STEP_MS}ms`));
  });

  test('picked up part-way it fades in: up through the silent bottom quickly, then the same dB every moment', async () => {
    const { mpv, player } = deck();
    mpv.props['playback-time'] = '42';
    mpv.calls = [];
    let soundingAt = -1;
    const pressed = Date.now();
    await player.play({ onSounding: () => { soundingAt = Date.now() - pressed; } });
    const done = Date.now() - pressed;

    assert.ok(soundingAt >= 0 && soundingAt < 50, `told it sounds after ${soundingAt}ms, not when the fade ended`);
    assert.ok(done > FADE_IN_MS - 200, `the fade still ran (${done}ms)`);
    assert.strictEqual(mpv.calls[1], 'pause=no', 'set quiet before it is let go');
    const curve = fadeDb(mpv.calls);
    assert.strictEqual(curve.length, FADE_IN_MS / STEP_MS + 1);
    curve.forEach((db, i) => near(db, fadeInDb(i * STEP_MS, FADE_IN_MS, EDGE_DB), `${i * STEP_MS}ms`));
    // Note(yoochan.kim): heard a tenth of the way in, or a press of play seems not to land.
    const heard = Math.ceil(Math.min(300, FADE_IN_MS / 10) / STEP_MS);
    assert.ok(curve[heard]! >= EDGE_DB - 1e-6, `${curve[heard]} dB at ${heard * STEP_MS}ms`);
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
    curve.forEach((db, i) => near(db, fadeInDb(i * STEP_MS, 1000, EDGE_DB), `${i * STEP_MS}ms`));
    near(curve[100 / STEP_MS]!, EDGE_DB, 'heard after a tenth of it');
  });

  test('pausing fades out the same way backwards, over its own length, then puts the level back for the next play', async () => {
    const { mpv, player } = deck();
    mpv.props['playback-time'] = '42';
    await player.play();
    mpv.calls = [];
    const pressed = Date.now();
    await player.pause();
    const took = Date.now() - pressed;

    assert.ok(took > FADE_OUT_MS - 200, `the fade out took ${took}ms`);
    const paused = mpv.calls.indexOf('pause=yes');
    const curve = fadeDb(mpv.calls.slice(0, paused));
    assert.strictEqual(curve.length, FADE_OUT_MS / STEP_MS - 1);
    curve.forEach((db, i) => near(db, fadeOutDb((i + 1) * STEP_MS, FADE_OUT_MS, EDGE_DB), `${(i + 1) * STEP_MS}ms`));
    assert.ok(curve.at(-1)! < -60, `out of hearing before it stops (${curve.at(-1)!.toFixed(1)} dB)`);
    near(fadeDb(mpv.calls.slice(paused))[0]!, 0, 'the level after');
  });
});
