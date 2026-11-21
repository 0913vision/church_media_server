import { test, describe, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { MuteState, PlaybackState } from '../../server/protocol.ts';
import type MpvClient from '../../server/hardware/MpvClient.ts';
import type Notifier from '../../server/notify/Notifier.ts';
import type TrackLibrary from '../../server/tracks/TrackLibrary.ts';
import type { LibraryEntry } from '../../server/tracks/TrackLibrary.ts';
import type { FlowTiming } from '../../server/constants/flowConfig.ts';
import type { Plan } from '../../server/flow/FlowRunner.ts';
import { testWatch } from './desk-watch.ts';

// Note(yoochan.kim): what a gate's end does to a deck a person is using, against a stand-in mpv, so nothing sounds.
type Modules = {
  Player: typeof import('../../server/player/Player.ts').default;
  AudioDevice: typeof import('../../server/hardware/AudioDevice.ts').default;
  FlowRunner: typeof import('../../server/flow/FlowRunner.ts').default;
  LockCoordinator: typeof import('../../server/lock/LockCoordinator.ts').default;
  AdminSession: typeof import('../../server/lock/AdminSession.ts').default;
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
    AdminSession: (await import('../../server/lock/AdminSession.ts')).default,
    Clock: (await import('../../server/clock/Clock.ts')).default,
    MockConsole: (await import('../../server/console/MockConsole.ts')).default,
    DeskHolds: (await import('../../server/console/DeskHolds.ts')).default,
    MixerConsole: (await import('../../server/console/MixerConsole.ts')).default,
  };
});

const TIMING: FlowTiming = { CUE_PRELOAD_MS: 300, CUE_GRACE_MS: 100, CUE_DESK_LEAD_MS: 300, CUE_LEAD_SLACK_MS: 200 };
const HOUR_SEC = 3600;

/** Records what it is told; a file it was asked to load has ended once the test says so. */
class FakeMpv {
  calls: { at: number; call: string }[] = [];
  readonly props: Record<string, string> = { volume: '50', 'playback-time': '0', 'idle-active': 'no', pause: 'yes' };

  setProperty(property: string, value: string): void {
    this.calls.push({ at: Date.now(), call: `${property}=${value}` });
    this.props[property] = value;
  }

  getProperty(property: string): string | null {
    return this.props[property] ?? null;
  }

  executeCommand(command: (string | null)[]): void {
    this.calls.push({ at: Date.now(), call: command.filter((part) => part !== null).join(' ') });
    if (command[0] === 'loadfile') this.props['idle-active'] = 'no';
  }

  /** What it was told after the mark, a count of calls rather than a time: much happens within one millisecond. */
  since(mark: number): string[] {
    return this.calls.slice(mark).map((entry) => entry.call);
  }
}

function entry(id: string, durationSec: number, volume: number): LibraryEntry {
  return { id, title: id, file: `/audio/${id}.mp3`, declaredFile: `./audio/${id}.mp3`, durationSec, volume, userSelectable: false, role: { kind: 'music' } };
}

const SERVICE = entry('service', 0.3, 60);
const HYMN = entry('hymn', 240, 50);

function rig() {
  const mpv = new FakeMpv();
  const device = new m.AudioDevice(mpv as unknown as MpvClient, 'calm', { calm: '/audio/calm.mp3' });
  const player = new m.Player(
    device,
    { serverVolume: 47, muted: MuteState.UNMUTED, state: PlaybackState.PAUSED, currentSong: 'calm' },
    () => 47,
    () => {},
  );
  const notifier = new Proxy({}, { get: () => () => {} }) as unknown as Notifier;
  const locks = new m.LockCoordinator(notifier);
  const desk = new m.MockConsole();
  const holds = new m.DeskHolds(desk, { CONFIRM_ATTEMPTS: 2, CONFIRM_GAP_MS: 5, RESTORE_RETRY_MS: 20 }, () => {}, [], testWatch());
  const runner = new m.FlowRunner(
    player, {} as unknown as TrackLibrary, locks, notifier, new m.Clock(0), new m.MixerConsole(desk, holds), [], TIMING,
  );
  return { mpv, player, locks, runner, notifier };
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A service whose music ends early and whose gate stays shut a while after, as on a Friday. */
const service = (t0: number, until: number): Plan => ({
  id: 'service', name: '금요 예배', lock: { at: new Date(t0 - 100), until: new Date(t0 + until) },
  parts: [{ kind: 'music', tracks: [SERVICE], startsAt: new Date(t0 + 100), endsAt: new Date(t0 + 400) }],
});

describe('A run\'s gate ending while a person uses the deck', () => {
  test('a panel song a person put on is left exactly as it is, and the gate opens', async () => {
    const { mpv, player, locks, runner } = rig();
    const t0 = Date.now();
    assert.deepEqual(runner.startPlan(service(t0, 1400)), { ok: true });

    await settle(700);
    assert.equal(player.getDeck().source, 'song', 'the run gave the deck back after its music');
    // Note(yoochan.kim): the 2026-11-20 case: the panel's song played again and raised, after the service's music.
    player.setVolume(70);
    await player.play({ fadeMs: 10 });
    player.setLoop(false);
    const touched = mpv.calls.length;

    await settle(1000);
    assert.equal(locks.getLockState().admin, false, 'the gate opened');
    assert.equal(player.getVolume(), 70, 'at the level the person set, not the one the run was handed');
    assert.equal(player.isPlaying(), true, 'still playing');
    assert.deepEqual(mpv.since(touched).filter((call) => call.startsWith('volume=') || call === 'pause=yes'), [], 'nothing it sounds changed');
    assert.equal(player.getLoop(), true, 'the panel\'s song repeats again, as when a person opens the gate');
  });

  test('a track only an admin can put on keeps the gate, as that person\'s hold', async () => {
    const { mpv, player, locks, runner } = rig();
    let handed = 0;
    runner.onGateHandedOver(() => { handed += 1; });
    const t0 = Date.now();
    assert.deepEqual(runner.startPlan(service(t0, 1400)), { ok: true });

    await settle(700);
    await player.selectTrack(HYMN, HYMN.volume, false);
    await player.play();
    const touched = mpv.calls.length;

    await settle(1000);
    assert.equal(runner.status().phase, 'idle', 'the run is over');
    assert.equal(locks.getLockState().admin, true, 'the gate stays shut');
    assert.equal(locks.adminGateHeldBy(), 'person', 'a person\'s now');
    assert.equal(handed, 1, 'and the hold told to start its hour');
    assert.deepEqual(player.getDeck(), { source: 'track', id: 'hymn' });
    assert.equal(player.isPlaying(), true);
    assert.deepEqual(mpv.since(touched).filter((call) => call.startsWith('volume=') || call === 'pause=yes'), [], 'nothing it sounds changed');
  });

  test('a run that still holds the deck as it is stopped puts back the deck it was handed', async () => {
    const { player, locks, runner } = rig();
    const t0 = Date.now();
    const plan: Plan = {
      id: 'service', name: '금요 예배', lock: { at: new Date(t0 - 100), until: new Date(t0 + 5000) },
      parts: [{ kind: 'music', tracks: [HYMN], startsAt: new Date(t0 + 100), endsAt: new Date(t0 + 4000) }],
    };
    assert.deepEqual(runner.startPlan(plan), { ok: true });

    await settle(600);
    assert.equal(runner.ownsDeck(), true);
    await runner.stop();
    assert.deepEqual(player.getDeck(), { source: 'song' });
    assert.equal(player.getVolume(), 47, 'the level it was handed');
    assert.equal(locks.getLockState().admin, false);
  });
});

describe('A person\'s hold lapsing', () => {
  function hold(t: { after(fn: () => void): void }) {
    const { mpv, player, locks, notifier } = rig();
    const clock = new m.Clock(0);
    const session = new m.AdminSession(player, locks, notifier, clock, { isPlaying: () => false });
    // Note(yoochan.kim): its poll would keep the test run alive past a failed assertion.
    t.after(() => session.dispose());
    locks.setAdminLock(true, 'person');
    session.engage();
    return { mpv, player, locks, clock };
  }

  test('never cuts a repeating track: it stops repeating, plays out, and only then does the gate open', async (t) => {
    const { mpv, player, locks, clock } = hold(t);
    await player.selectTrack(HYMN, HYMN.volume, true);
    await player.play();
    const playing = mpv.calls.length;

    clock.setOffset(HOUR_SEC + 1);
    await settle(1300);
    assert.equal(player.getLoop(), false, 'its repeat turned off');
    assert.equal(locks.getLockState().admin, true, 'the gate still shut');
    assert.equal(player.isPlaying(), true);
    assert.deepEqual(mpv.since(playing).filter((call) => call.startsWith('volume=') || call === 'pause=yes'), [], 'not faded or paused');

    mpv.props['idle-active'] = 'yes';
    await settle(1300);
    assert.equal(locks.getLockState().admin, false, 'opened once it ended');
    assert.deepEqual(player.getDeck(), { source: 'song' }, 'the panel\'s song back, paused');
  });

  test('a track that has already ended is not waited on forever', async (t) => {
    const { mpv, player, locks, clock } = hold(t);
    await player.selectTrack(HYMN, HYMN.volume, false);
    await player.play();
    mpv.props['idle-active'] = 'yes';

    clock.setOffset(HOUR_SEC + 1);
    await settle(1300);
    assert.equal(locks.getLockState().admin, false);
    assert.deepEqual(player.getDeck(), { source: 'song' });
  });
});
