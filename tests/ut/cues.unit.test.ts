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

// Note(yoochan.kim): a run's cues against a stand-in mpv that writes down what it was
// told and when, so nothing here can make a sound. The modules read env-backed
// config and log at load, so they are loaded once that is set.
type Modules = {
  Player: typeof import('../../server/player/Player.ts').default;
  AudioDevice: typeof import('../../server/hardware/AudioDevice.ts').default;
  FlowRunner: typeof import('../../server/flow/FlowRunner.ts').default;
  timelineConflict: typeof import('../../server/flow/FlowRunner.ts').timelineConflict;
  LockCoordinator: typeof import('../../server/lock/LockCoordinator.ts').default;
  Clock: typeof import('../../server/clock/Clock.ts').default;
};
let m: Modules;

before(async () => {
  process.env.LOG_LEVEL ??= 'warn';
  process.env.CONSOLE_MODE ??= 'MOCK';
  process.env.MPV_LIBRARY_PATH ??= '/opt/homebrew/lib/libmpv.dylib';
  const flow = await import('../../server/flow/FlowRunner.ts');
  m = {
    Player: (await import('../../server/player/Player.ts')).default,
    AudioDevice: (await import('../../server/hardware/AudioDevice.ts')).default,
    FlowRunner: flow.default,
    timelineConflict: flow.timelineConflict,
    LockCoordinator: (await import('../../server/lock/LockCoordinator.ts')).default,
    Clock: (await import('../../server/clock/Clock.ts')).default,
  };
});

/** Short, so a run takes a second or two; the shape is what is checked. */
const TIMING: FlowTiming = { CUE_PRELOAD_MS: 300, CUE_GRACE_MS: 100 };
/** How far off its time a timer may land under a loaded test run. */
const SLACK_MS = 50;

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
  }

  /** When mpv was first told this, after `from`. */
  when(call: string, from = 0): number | undefined {
    return this.calls.find((entry) => entry.call === call && entry.at >= from)?.at;
  }
}

function entry(id: string, durationSec: number, volume: number): LibraryEntry {
  return { id, title: id, file: `/audio/${id}.mp3`, declaredFile: `./audio/${id}.mp3`, durationSec, volume, userSelectable: false };
}

function rig() {
  const mpv = new FakeMpv();
  const device = new m.AudioDevice(mpv as unknown as MpvClient, 'calm', { calm: '/audio/calm.mp3' });
  const player = new m.Player(
    device,
    { serverVolume: 40, muted: MuteState.UNMUTED, state: PlaybackState.PAUSED, currentSong: 'calm' },
    () => 50,
    () => {},
  );
  const notifier = new Proxy({}, { get: () => () => {} }) as unknown as Notifier;
  const locks = new m.LockCoordinator(notifier);
  const runner = new m.FlowRunner(player, {} as TrackLibrary, locks, notifier, new m.Clock(0), TIMING);
  return { mpv, player, locks, runner };
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const near = (actual: number | undefined, want: number, what: string): void => {
  assert.ok(actual !== undefined, `${what}: never happened`);
  assert.ok(Math.abs(actual - want) < SLACK_MS, `${what}: at ${actual}ms, want ${want}ms`);
};
/** Reads ownsDeck at each of these moments after t0. */
function sampleDeck(runner: { ownsDeck(): boolean }, t0: number, moments: number[]): Record<number, boolean> {
  const seen: Record<number, boolean> = {};
  for (const ms of moments) setTimeout(() => { seen[ms] = runner.ownsDeck(); }, t0 + ms - Date.now());
  return seen;
}
const cuesPlan = (lock: { at: Date; until: Date }, cues: { track: LibraryEntry; at: Date }[]): Plan =>
  ({ id: 'cues', name: '안내', lock, parts: [{ kind: 'cues', cues }] });

describe('A run\'s cues', () => {
  test('each goes on the deck ahead of its second, paused, and starts on it', async () => {
    const { mpv, runner } = rig();
    const t0 = Date.now();
    const plan = cuesPlan({ at: new Date(t0 - 1000), until: new Date(t0 + 2600) }, [
      { track: entry('min', 0.5, 40), at: new Date(t0 + 700) },
      { track: entry('count', 0.4, 70), at: new Date(t0 + 1600) },
    ]);
    const deck = sampleDeck(runner, t0, [200, 1250, 2300]);

    assert.deepEqual(runner.startPlan(plan), { ok: true });
    await settle(2400);

    const loadMin = mpv.when('loadfile /audio/min.mp3');
    near(loadMin === undefined ? undefined : loadMin - t0, 400, 'the first cue loaded');
    near(mpv.when('pause=no', loadMin) === undefined ? undefined : mpv.when('pause=no', loadMin)! - t0, 700, 'the first cue started');
    // The second loads once the first has ended (1200) and its own lead begins (1300).
    const loadCount = mpv.when('loadfile /audio/count.mp3');
    near(loadCount === undefined ? undefined : loadCount - t0, 1300, 'the second cue loaded');
    near(mpv.when('pause=no', loadCount) === undefined ? undefined : mpv.when('pause=no', loadCount)! - t0, 1600, 'the second cue started');

    const before = (call: string): string | undefined => {
      const at = mpv.calls.findIndex((entryCall) => entryCall.call === call);
      return mpv.calls.slice(0, at).reverse().find((entryCall) => entryCall.call.startsWith('volume='))?.call;
    };
    assert.equal(before('loadfile /audio/min.mp3'), `volume=${mpvVolumeFromDb(dbFromLevel(40))}`);
    assert.equal(before('loadfile /audio/count.mp3'), `volume=${mpvVolumeFromDb(dbFromLevel(70))}`);

    const back = mpv.when('loadfile /audio/calm.mp3', loadCount);
    near(back === undefined ? undefined : back - t0, 2000, 'the song came back once the last cue ended');
    assert.deepEqual(deck, { 200: false, 1250: true, 2300: false });
  });

  test('a cue whose second has gone by is skipped, not joined part-way', async () => {
    const { mpv, runner } = rig();
    const t0 = Date.now();
    const plan = cuesPlan({ at: new Date(t0 - 3000), until: new Date(t0 + 1200) }, [
      { track: entry('past', 0.5, 40), at: new Date(t0 - 1000) },
      { track: entry('next', 0.3, 40), at: new Date(t0 + 500) },
    ]);

    assert.deepEqual(runner.startPlan(plan), { ok: true });
    await settle(1000);

    assert.equal(mpv.when('loadfile /audio/past.mp3'), undefined);
    const load = mpv.when('loadfile /audio/next.mp3');
    near(mpv.when('pause=no', load) === undefined ? undefined : mpv.when('pause=no', load)! - t0, 500, 'the next cue started');
  });

  test('after the run\'s music the deck stays the run\'s through the quiet, and goes back once, after the last cue', async () => {
    const { mpv, runner } = rig();
    const t0 = Date.now();
    const plan: Plan = {
      id: 'service', name: '예배 전', lock: { at: new Date(t0 - 500), until: new Date(t0 + 2600) },
      parts: [
        { kind: 'music', tracks: [entry('song', 0.8, 50)], startsAt: new Date(t0 + 200), endsAt: new Date(t0 + 1000) },
        { kind: 'cues', cues: [{ track: entry('min', 0.4, 40), at: new Date(t0 + 1500) }] },
      ],
    };
    const deck = sampleDeck(runner, t0, [1100, 2100]);

    assert.deepEqual(runner.startPlan(plan), { ok: true });
    await settle(2200);

    const song = mpv.when('loadfile /audio/song.mp3');
    near(song === undefined ? undefined : song - t0, 200, 'the music started');
    const cue = mpv.when('loadfile /audio/min.mp3');
    near(cue === undefined ? undefined : cue - t0, 1200, 'the cue loaded, after the music had ended');
    const backs = mpv.calls.filter((entryCall) => entryCall.call === 'loadfile /audio/calm.mp3' && entryCall.at > song!);
    assert.equal(backs.length, 1, 'the song came back once, not between the music and the cue');
    near(backs[0]!.at - t0, 1900, 'the song came back after the cue');
    assert.deepEqual(deck, { 1100: true, 2100: false });
  });

  test('a stop in the middle of a cue puts the deck back and opens the gate', async () => {
    const { mpv, runner, locks } = rig();
    const t0 = Date.now();
    const plan = cuesPlan({ at: new Date(t0 - 500), until: new Date(t0 + 5000) }, [
      { track: entry('count', 2, 70), at: new Date(t0 + 400) },
    ]);

    assert.deepEqual(runner.startPlan(plan), { ok: true });
    await settle(700);
    assert.equal(runner.ownsDeck(), true);
    assert.equal(runner.uses('count'), true, 'a cue\'s track is one the run uses');
    assert.equal(runner.uses('other'), false);

    const stopped = Date.now();
    await runner.stop();
    assert.equal(runner.ownsDeck(), false);
    assert.equal(locks.adminGateHeldBy(), null);
    assert.ok(mpv.when('loadfile /audio/calm.mp3', stopped) !== undefined, 'the song came back');
  });

  test('a muted deck stays silent through a cue', async () => {
    const { mpv, player, runner } = rig();
    player.setMute(MuteState.MUTED);
    const t0 = Date.now();
    const plan = cuesPlan({ at: new Date(t0 - 500), until: new Date(t0 + 900) }, [
      { track: entry('min', 0.3, 70), at: new Date(t0 + 300) },
    ]);

    assert.deepEqual(runner.startPlan(plan), { ok: true });
    await settle(1000);

    const load = mpv.calls.findIndex((entryCall) => entryCall.call === 'loadfile /audio/min.mp3');
    assert.ok(load > 0);
    const volume = mpv.calls.slice(0, load).reverse().find((entryCall) => entryCall.call.startsWith('volume='))?.call;
    assert.equal(volume, 'volume=0');
  });
});

describe('A timeline with cues', () => {
  const t = Date.UTC(2026, 9, 25, 10, 0, 0);
  const lock = { at: new Date(t), until: new Date(t + 60_000) };
  const music = { kind: 'music' as const, tracks: [entry('song', 30, 50)], startsAt: new Date(t), endsAt: new Date(t + 30_000) };
  const cues = (...list: [number, number][]) =>
    ({ kind: 'cues' as const, cues: list.map(([atMs, sec], i) => ({ track: entry(`cue${i}`, sec, 50), at: new Date(t + atMs) })) });

  test('may not sound under the run\'s music', () => {
    assert.equal(m.timelineConflict({ lock, parts: [music, cues([29_000, 2])] }), 'cueOverlapsMusic');
    assert.equal(m.timelineConflict({ lock, parts: [music, cues([30_000, 2])] }), null, 'right after it is fine');
  });

  test('may not sound over another cue', () => {
    assert.equal(m.timelineConflict({ lock, parts: [cues([40_000, 2], [41_000, 1])] }), 'cuesOverlap');
    assert.equal(m.timelineConflict({ lock, parts: [cues([45_000, 1], [31_000, 1])] }), null, 'given out of order, it is put in order');
  });

  test('must sound inside the gate', () => {
    assert.equal(m.timelineConflict({ lock, parts: [cues([59_000, 2])] }), 'cueOutsideLock');
    assert.equal(m.timelineConflict({ lock, parts: [cues([-1000, 0.5])] }), 'cueOutsideLock');
  });

  test('music that began before the gate is counted from the gate', () => {
    const early = { ...music, startsAt: new Date(t - 10_000), endsAt: new Date(t + 5000) };
    assert.equal(m.timelineConflict({ lock, parts: [early, cues([6000, 1])] }), null);
    assert.equal(m.timelineConflict({ lock, parts: [early, cues([1000, 1])] }), 'cueOverlapsMusic');
  });

  test('is refused by the runner before anything happens', () => {
    const { mpv, runner } = rig();
    mpv.calls = [];
    const now = Date.now();
    const plan: Plan = {
      id: 'x', name: 'x', lock: { at: new Date(now), until: new Date(now + 60_000) },
      parts: [
        { kind: 'music', tracks: [entry('song', 30, 50)], startsAt: new Date(now), endsAt: new Date(now + 30_000) },
        { kind: 'cues', cues: [{ track: entry('min', 2, 40), at: new Date(now + 29_000) }] },
      ],
    };
    assert.deepEqual(runner.startPlan(plan), { ok: false, reason: 'cueOverlapsMusic' });
    assert.equal(runner.ownsDeck(), false);
    assert.deepEqual(mpv.calls, []);
  });
});
