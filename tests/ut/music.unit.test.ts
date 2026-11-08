import { test, describe, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { MuteState, PlaybackState } from '../../server/protocol.ts';
import type MpvClient from '../../server/hardware/MpvClient.ts';
import type Notifier from '../../server/notify/Notifier.ts';
import type TrackLibrary from '../../server/tracks/TrackLibrary.ts';
import type { LibraryEntry } from '../../server/tracks/TrackLibrary.ts';
import type { FlowTiming } from '../../server/constants/flowConfig.ts';
import type { Plan } from '../../server/flow/FlowRunner.ts';
import { dbFromLevel, mpvVolumeFromDb } from '../../server/hardware/loudness.ts';

// Note(yoochan.kim): a run's music against a stand-in mpv, so nothing sounds; modules load after env is set.
type Modules = {
  Player: typeof import('../../server/player/Player.ts').default;
  AudioDevice: typeof import('../../server/hardware/AudioDevice.ts').default;
  FlowRunner: typeof import('../../server/flow/FlowRunner.ts').default;
  LockCoordinator: typeof import('../../server/lock/LockCoordinator.ts').default;
  Clock: typeof import('../../server/clock/Clock.ts').default;
  MockConsole: typeof import('../../server/console/MockConsole.ts').default;
  DeskHolds: typeof import('../../server/console/DeskHolds.ts').default;
  MixerConsole: typeof import('../../server/console/MixerConsole.ts').default;
};
let m: Modules;

before(async () => {
  process.env.LOG_LEVEL ??= 'warn';
  process.env.CONSOLE_MODE ??= 'MOCK';
  process.env.MPV_LIBRARY_PATH ??= '/opt/homebrew/lib/libmpv.dylib';
  process.env.X32_REMOTE_ADDRESS ??= '127.0.0.1';
  process.env.X32_REMOTE_PORT ??= '10023';
  m = {
    Player: (await import('../../server/player/Player.ts')).default,
    AudioDevice: (await import('../../server/hardware/AudioDevice.ts')).default,
    FlowRunner: (await import('../../server/flow/FlowRunner.ts')).default,
    LockCoordinator: (await import('../../server/lock/LockCoordinator.ts')).default,
    Clock: (await import('../../server/clock/Clock.ts')).default,
    MockConsole: (await import('../../server/console/MockConsole.ts')).default,
    DeskHolds: (await import('../../server/console/DeskHolds.ts')).default,
    MixerConsole: (await import('../../server/console/MixerConsole.ts')).default,
  };
});

const TIMING: FlowTiming = { CUE_PRELOAD_MS: 300, CUE_GRACE_MS: 100, CUE_DESK_LEAD_MS: 300, CUE_LEAD_SLACK_MS: 200 };
/** How far off its time a timer may land under a loaded test run. */
const SLACK_MS = 50;

function entry(id: string, durationSec: number, volume: number): LibraryEntry {
  return { id, title: id, file: `/audio/${id}.mp3`, declaredFile: `./audio/${id}.mp3`, durationSec, volume, userSelectable: false, role: { kind: 'music' } };
}

/** A stand-in mpv with a playlist: a file appended plays when the one sounding reaches its length, as gapless mpv runs on. */
class PlaylistMpv {
  calls: { at: number; call: string }[] = [];
  readonly props: Record<string, string> = { volume: '50', 'playback-time': '0', 'idle-active': 'no', pause: 'yes' };
  private current: string | null = null;
  /** When the file on now began sounding; null until it is unpaused. */
  private since: number | null = null;
  private queue: string[] = [];

  constructor(private readonly lengths: Map<string, number>, private readonly runsOn = true) {}

  setProperty(property: string, value: string): void {
    this.calls.push({ at: Date.now(), call: `${property}=${value}` });
    this.props[property] = value;
    if (property === 'pause' && value === 'no' && this.since === null) this.since = Date.now();
  }

  getProperty(property: string): string | null {
    if (property === 'path') {
      this.runOn();
      return this.current;
    }
    return this.props[property] ?? null;
  }

  executeCommand(command: (string | null)[]): void {
    this.calls.push({ at: Date.now(), call: command.filter((part) => part !== null).join(' ') });
    const [name, file, flag] = command;
    if (name === 'loadfile' && flag === 'append') this.queue.push(file!);
    else if (name === 'loadfile') {
      this.current = file!;
      this.since = null;
      this.queue = [];
    } else if (name === 'playlist-clear') this.queue = [];
  }

  private runOn(): void {
    while (this.runsOn && this.current !== null && this.since !== null && this.queue.length > 0) {
      const ends = this.since + (this.lengths.get(this.current) ?? Infinity) * 1000;
      if (Date.now() < ends) return;
      this.current = this.queue.shift()!;
      this.since = ends;
    }
  }

  when(call: string, from = 0): number | undefined {
    return this.calls.find((entryCall) => entryCall.call === call && entryCall.at >= from)?.at;
  }
}

const A = entry('a', 0.6, 40);
const B = entry('b', 0.5, 60);
const C = entry('c', 0.4, 70);

/** Each file's real length: by default its manifest length; a file can be shorter, as an mp3's padding makes it. */
function rig(runsOn = true, lengths = new Map([A, B, C].map((track) => [track.file, track.durationSec]))) {
  const mpv = new PlaylistMpv(lengths, runsOn);
  const device = new m.AudioDevice(mpv as unknown as MpvClient, 'calm', { calm: '/audio/calm.mp3' });
  const player = new m.Player(
    device,
    { serverVolume: 40, muted: MuteState.UNMUTED, state: PlaybackState.PAUSED, currentSong: 'calm' },
    () => 50,
    () => {},
  );
  const notifier = new Proxy({}, { get: () => () => {} }) as unknown as Notifier;
  const locks = new m.LockCoordinator(notifier);
  const desk = new m.MockConsole();
  const holds = new m.DeskHolds(desk, { CONFIRM_ATTEMPTS: 2, CONFIRM_GAP_MS: 5, RESTORE_RETRY_MS: 20 }, () => {}, []);
  const runner = new m.FlowRunner(
    player, {} as unknown as TrackLibrary, locks, notifier, new m.Clock(0), new m.MixerConsole(desk, holds), [], TIMING,
  );
  return { mpv, player, runner };
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const near = (actual: number | undefined, want: number, what: string): void => {
  assert.ok(actual !== undefined, `${what}: never happened`);
  assert.ok(Math.abs(actual - want) < SLACK_MS, `${what}: at ${actual}ms, want ${want}ms`);
};
const music = (t0: number, lockAt: number, startsAt: number): Plan => ({
  id: 'service', name: '예배 전', lock: { at: new Date(t0 + lockAt), until: new Date(t0 + 3000) },
  parts: [{ kind: 'music', tracks: [A, B, C], startsAt: new Date(t0 + startsAt), endsAt: new Date(t0 + startsAt + 1500) }],
});
const level = (track: LibraryEntry): string => `volume=${mpvVolumeFromDb(dbFromLevel(track.volume))}`;

describe('A run\'s music', () => {
  test('the first track goes on the deck paused ahead and starts by an unpause; each next is queued and run on into, never loaded', async () => {
    const { mpv, runner } = rig();
    const t0 = Date.now();
    assert.deepEqual(runner.startPlan(music(t0, -500, 500)), { ok: true });
    await settle(2300);

    // Note(yoochan.kim): a at 500 (loaded 300 ahead), b at 1100, c at 1600, the music over at 2000.
    const loadA = mpv.when('loadfile /audio/a.mp3');
    near(loadA === undefined ? undefined : loadA - t0, 200, 'a loaded ahead');
    const startA = mpv.when('pause=no', loadA);
    near(startA === undefined ? undefined : startA - t0, 500, 'a started by an unpause on its boundary');
    const queueB = mpv.when('loadfile /audio/b.mp3 append');
    near(queueB === undefined ? undefined : queueB - t0, 500, 'b queued as a started');
    const queueC = mpv.when('loadfile /audio/c.mp3 append');
    near(queueC === undefined ? undefined : queueC - t0, 1100, 'c queued as b came on');

    assert.equal(mpv.when('loadfile /audio/b.mp3'), undefined, 'b never loaded at its boundary');
    assert.equal(mpv.when('loadfile /audio/c.mp3'), undefined, 'c never loaded at its boundary');
    const levelB = mpv.when(level(B), startA);
    near(levelB === undefined ? undefined : levelB - t0, 1100, 'b took its level as it came on');
    const levelC = mpv.when(level(C), levelB);
    near(levelC === undefined ? undefined : levelC - t0, 1600, 'c took its level as it came on');
    const back = mpv.when('loadfile /audio/calm.mp3', startA);
    near(back === undefined ? undefined : back - t0, 2000, 'the song came back as the music ended');
    // Note(yoochan.kim): the song coming back is sought to where it was; the run's own tracks never are.
    assert.ok(!mpv.calls.some((entryCall) => entryCall.call.startsWith('playback-time=') && entryCall.at < back!), 'nothing of the run sought');
  });

  test('a track whose file ends before its length runs on early, and the next takes its level as it comes on', async () => {
    const { mpv, runner } = rig(true, new Map([[A.file, 0.45], [B.file, B.durationSec], [C.file, C.durationSec]]));
    const t0 = Date.now();
    assert.deepEqual(runner.startPlan(music(t0, -500, 500)), { ok: true });
    await settle(1300);

    // Note(yoochan.kim): a really ends at 950, 150 before its boundary at 1100, and b plays on from there.
    const levelB = mpv.when(level(B), t0 + 600);
    near(levelB === undefined ? undefined : levelB - t0, 950, 'b took its level as it came on, not at its boundary');
    assert.equal(mpv.when('loadfile /audio/b.mp3'), undefined, 'and was never loaded');
    await runner.stop();
  });

  test('a queued track that has not come on by its boundary is loaded there instead', async () => {
    const { mpv, runner } = rig(false);
    const t0 = Date.now();
    assert.deepEqual(runner.startPlan(music(t0, -500, 500)), { ok: true });
    await settle(1600);

    const cleared = mpv.when('playlist-clear', t0 + 1000);
    near(cleared === undefined ? undefined : cleared - t0, 1400, 'the queue dropped after waiting 300ms');
    const loadB = mpv.when('loadfile /audio/b.mp3');
    near(loadB === undefined ? undefined : loadB - t0, 1400, 'b loaded instead');
    await runner.stop();
  });

  test('a stop drops what was queued before the deck goes back', async () => {
    const { mpv, runner } = rig();
    const t0 = Date.now();
    assert.deepEqual(runner.startPlan(music(t0, -500, 200)), { ok: true });
    await settle(400);
    await runner.stop();

    const cleared = mpv.calls.findIndex((entryCall) => entryCall.call === 'playlist-clear');
    const back = mpv.calls.findIndex((entryCall) => entryCall.call === 'loadfile /audio/calm.mp3' && entryCall.at > t0 + 200);
    assert.ok(cleared !== -1 && back !== -1 && cleared < back, 'the queue cleared, then the song put back');
    assert.equal(mpv.when('loadfile /audio/b.mp3'), undefined);
  });

  test('started late, its track is put paused where the timeline will be half a second on, and started then', async () => {
    const { mpv, runner } = rig();
    const long = entry('long', 5, 50);
    const t0 = Date.now();
    const plan: Plan = {
      id: 'late', name: '늦은 시작', lock: { at: new Date(t0 - 3000), until: new Date(t0 + 4000) },
      parts: [{ kind: 'music', tracks: [long], startsAt: new Date(t0 - 2000), endsAt: new Date(t0 + 3000) }],
    };
    assert.deepEqual(runner.startPlan(plan), { ok: true });
    await settle(800);

    const load = mpv.when('loadfile /audio/long.mp3');
    near(load === undefined ? undefined : load - t0, 0, 'loaded at once');
    const seek = mpv.calls.find((entryCall) => entryCall.call.startsWith('playback-time='));
    const at = Number(seek?.call.slice('playback-time='.length));
    assert.ok(Math.abs(at - 2.5) < SLACK_MS / 1000, `put where the timeline is at 500: ${at}s`);
    const start = mpv.when('pause=no', load);
    near(start === undefined ? undefined : start - t0, 500, 'started as the timeline got there');
    await runner.stop();
  });

  test('never put on the deck before the gate, nor over a person\'s song that is playing', async () => {
    const gated = rig();
    const t0 = Date.now();
    assert.deepEqual(gated.runner.startPlan(music(t0, 400, 400)), { ok: true });
    await settle(250);
    assert.equal(gated.runner.ownsDeck(), false, 'the deck the panel\'s until the gate');
    await settle(250);
    const loadA = gated.mpv.when('loadfile /audio/a.mp3');
    near(loadA === undefined ? undefined : loadA - t0, 400, 'a loaded as the gate engaged');
    await gated.runner.stop();

    const playing = rig();
    await playing.player.play();
    const t1 = Date.now();
    assert.deepEqual(playing.runner.startPlan(music(t1, -500, 500)), { ok: true });
    await settle(350);
    assert.equal(playing.mpv.when('loadfile /audio/a.mp3'), undefined, 'the song still playing, so nothing cued over it');
    await playing.runner.stop();
  });
});
