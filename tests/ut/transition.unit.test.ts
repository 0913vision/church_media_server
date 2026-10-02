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
  private readonly props: Record<string, string> = { volume: '50', 'playback-time': '0', 'idle-active': 'no', pause: 'yes' };

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
