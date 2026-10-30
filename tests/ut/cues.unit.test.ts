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
import { int } from '../../server/console/desk.ts';
import type { DeskChange } from '../../server/console/desk.ts';
import { dbFromFader } from '../../server/console/faderLevel.ts';

// Note(yoochan.kim): a run's cues against a stand-in mpv that writes down what it was
// told and when, so nothing here can make a sound. The modules read env-backed
// config and log at load, so they are loaded once that is set.
type Modules = {
  Player: typeof import('../../server/player/Player.ts').default;
  AudioDevice: typeof import('../../server/hardware/AudioDevice.ts').default;
  FlowRunner: typeof import('../../server/flow/FlowRunner.ts').default;
  timelineConflict: typeof import('../../server/flow/FlowRunner.ts').timelineConflict;
  countdownBlock: typeof import('../../server/flow/FlowRunner.ts').countdownBlock;
  LockCoordinator: typeof import('../../server/lock/LockCoordinator.ts').default;
  Clock: typeof import('../../server/clock/Clock.ts').default;
  MockConsole: typeof import('../../server/console/MockConsole.ts').default;
  DeskHolds: typeof import('../../server/console/DeskHolds.ts').default;
  MixerConsole: typeof import('../../server/console/MixerConsole.ts').default;
  BAND_ONLY: typeof import('../../server/constants/consoleConfig.ts').CONSOLE_CONFIG.BAND_ONLY;
};
let m: Modules;

before(async () => {
  process.env.LOG_LEVEL ??= 'warn';
  process.env.CONSOLE_MODE ??= 'MOCK';
  process.env.MPV_LIBRARY_PATH ??= '/opt/homebrew/lib/libmpv.dylib';
  process.env.X32_REMOTE_ADDRESS ??= '127.0.0.1';
  process.env.X32_REMOTE_PORT ??= '10023';
  const flow = await import('../../server/flow/FlowRunner.ts');
  m = {
    Player: (await import('../../server/player/Player.ts')).default,
    AudioDevice: (await import('../../server/hardware/AudioDevice.ts')).default,
    FlowRunner: flow.default,
    timelineConflict: flow.timelineConflict,
    countdownBlock: flow.countdownBlock,
    LockCoordinator: (await import('../../server/lock/LockCoordinator.ts')).default,
    Clock: (await import('../../server/clock/Clock.ts')).default,
    MockConsole: (await import('../../server/console/MockConsole.ts')).default,
    DeskHolds: (await import('../../server/console/DeskHolds.ts')).default,
    MixerConsole: (await import('../../server/console/MixerConsole.ts')).default,
    BAND_ONLY: (await import('../../server/constants/consoleConfig.ts')).CONSOLE_CONFIG.BAND_ONLY,
  };
});

/** Short, so a run takes a second or two; the shape is what is checked. */
const TIMING: FlowTiming = { CUE_PRELOAD_MS: 300, CUE_GRACE_MS: 100, CUE_DESK_LEAD_MS: 300, CUE_LEAD_SLACK_MS: 200 };
const HOLD_TIMING = { CONFIRM_ATTEMPTS: 2, CONFIRM_GAP_MS: 5, RESTORE_RETRY_MS: 20 };
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
  const desk = new m.MockConsole();
  const holds = new m.DeskHolds(desk, HOLD_TIMING, () => {}, []);
  const mixer = new m.MixerConsole(desk, holds);
  const clock = new m.Clock(0);
  const runner = new m.FlowRunner(player, {} as TrackLibrary, locks, notifier, clock, mixer, TIMING);
  return { mpv, player, locks, runner, desk, holds, clock };
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
const countdownPlan = (lock: { at: Date; until: Date }, cues: { track: LibraryEntry; at: Date }[], desk?: DeskChange[]): Plan =>
  ({ id: 'countdown', name: '카운트다운', lock, parts: [{ kind: 'countdown', cues, desk }] });

describe('A run\'s countdown', () => {
  test('each clip goes on the deck as soon as the step before is done, paused, and starts on its second', async () => {
    const { mpv, runner } = rig();
    const t0 = Date.now();
    const plan = countdownPlan({ at: new Date(t0 - 1000), until: new Date(t0 + 2600) }, [
      { track: entry('min', 0.5, 40), at: new Date(t0 + 700) },
      { track: entry('count', 0.4, 70), at: new Date(t0 + 1600) },
    ]);
    const deck = sampleDeck(runner, t0, [100, 1250, 2300]);

    assert.deepEqual(runner.startPlan(plan), { ok: true });
    await settle(2400);

    // The block opens at 200 (500 before the first, no desk): the deck is taken and the first loaded then.
    const loadMin = mpv.when('loadfile /audio/min.mp3');
    near(loadMin === undefined ? undefined : loadMin - t0, 200, 'the first cue loaded');
    near(mpv.when('pause=no', loadMin) === undefined ? undefined : mpv.when('pause=no', loadMin)! - t0, 700, 'the first cue started');
    // The second loads the moment the first has ended (1200), not at a lead of its own.
    const loadCount = mpv.when('loadfile /audio/count.mp3');
    near(loadCount === undefined ? undefined : loadCount - t0, 1200, 'the second cue loaded');
    near(mpv.when('pause=no', loadCount) === undefined ? undefined : mpv.when('pause=no', loadCount)! - t0, 1600, 'the second cue started');

    const before = (call: string): string | undefined => {
      const at = mpv.calls.findIndex((entryCall) => entryCall.call === call);
      return mpv.calls.slice(0, at).reverse().find((entryCall) => entryCall.call.startsWith('volume='))?.call;
    };
    assert.equal(before('loadfile /audio/min.mp3'), `volume=${mpvVolumeFromDb(dbFromLevel(40))}`);
    assert.equal(before('loadfile /audio/count.mp3'), `volume=${mpvVolumeFromDb(dbFromLevel(70))}`);

    const back = mpv.when('loadfile /audio/calm.mp3', loadCount);
    near(back === undefined ? undefined : back - t0, 2000, 'the song came back once the last cue ended');
    assert.deepEqual(deck, { 100: false, 1250: true, 2300: false });
  });

  test('a flow cannot be started inside its countdown\'s block, and nothing happens', () => {
    const { mpv, runner } = rig();
    mpv.calls = [];
    const t0 = Date.now();
    const plan = countdownPlan({ at: new Date(t0 - 3000), until: new Date(t0 + 1200) }, [
      { track: entry('min', 0.5, 40), at: new Date(t0 - 1000) },
      { track: entry('count', 0.3, 40), at: new Date(t0 + 500) },
    ]);

    assert.deepEqual(runner.startPlan(plan), { ok: false, reason: 'countdownUnderway' });
    assert.equal(runner.ownsDeck(), false);
    assert.deepEqual(mpv.calls, []);
  });

  test('once the block is over the flow may start, the countdown behind it', async () => {
    const { mpv, runner } = rig();
    const t0 = Date.now();
    const plan = countdownPlan({ at: new Date(t0 - 5000), until: new Date(t0 + 600) }, [
      { track: entry('count', 0.5, 40), at: new Date(t0 - 2000) },
    ]);

    assert.deepEqual(runner.startPlan(plan), { ok: true });
    await settle(300);
    assert.equal(mpv.when('loadfile /audio/count.mp3'), undefined, 'not played');
    assert.equal(runner.ownsDeck(), false, 'the deck left alone');
    await runner.stop();
  });

  test('started late with its block still ahead, the music joins part-way and the countdown plays whole', async () => {
    const { mpv, runner } = rig();
    const t0 = Date.now();
    const plan: Plan = {
      id: 'late', name: '늦은 시작', lock: { at: new Date(t0 - 3000), until: new Date(t0 + 3400) },
      parts: [
        // More of it left than a fade in takes, which holds the deck until it is done.
        { kind: 'music', tracks: [entry('song', 4.4, 50)], startsAt: new Date(t0 - 2000), endsAt: new Date(t0 + 2400) },
        { kind: 'countdown', cues: [{ track: entry('count', 0.4, 70), at: new Date(t0 + 2900) }] },
      ],
    };

    assert.deepEqual(runner.startPlan(plan), { ok: true });
    await settle(3400);

    assert.ok(mpv.calls.some((call) => call.call.startsWith('playback-time=')), 'the music sought to where it already was');
    const load = mpv.when('loadfile /audio/count.mp3');
    near(mpv.when('pause=no', load) === undefined ? undefined : mpv.when('pause=no', load)! - t0, 2900, 'the countdown on its second');
  });

  test('reached a little late, within the slack at its front, the block still plays on time', async () => {
    const { mpv, runner, clock } = rig();
    const t0 = Date.now();
    const plan = countdownPlan({ at: new Date(t0 - 300), until: new Date(t0 + 1500) }, [
      { track: entry('count', 0.3, 40), at: new Date(t0 + 700) },
    ]);

    assert.deepEqual(runner.startPlan(plan), { ok: true });
    // The block opens at 200ms by the wall; the church clock moves 100ms on meanwhile, inside the 200ms slack.
    setTimeout(() => clock.setOffset(0.1), 100);
    await settle(1000);

    const load = mpv.when('loadfile /audio/count.mp3');
    near(mpv.when('pause=no', load) === undefined ? undefined : mpv.when('pause=no', load)! - t0, 600, 'on its second by the church clock');
    await runner.stop();
  });

  test('a late start in the music\'s last moments fades in only for what is left, and the block after it is on time', async () => {
    const { mpv, runner } = rig();
    const t0 = Date.now();
    const plan: Plan = {
      id: 'late', name: '늦은 시작', lock: { at: new Date(t0 - 3000), until: new Date(t0 + 1600) },
      parts: [
        { kind: 'music', tracks: [entry('song', 2.3, 50)], startsAt: new Date(t0 - 2000), endsAt: new Date(t0 + 300) },
        { kind: 'countdown', cues: [{ track: entry('count', 0.4, 70), at: new Date(t0 + 1000) }] },
      ],
    };

    assert.deepEqual(runner.startPlan(plan), { ok: true });
    await settle(1500);

    // The music's own fade: what mpv was told after the song was loaded, until the block
    // opens at 500ms. Counted by order, not by time — the deck's own setting up can
    // land in the same millisecond as the load.
    const loaded = mpv.calls.findIndex((call) => call.call === 'loadfile /audio/song.mp3');
    const song = mpv.calls[loaded]!.at;
    const steps = mpv.calls.slice(loaded + 1).filter((call) => call.at < t0 + 450 && call.call.startsWith('volume='));
    assert.ok(steps.length <= 300 / 50 + 2, `the fade in took ${steps.length} steps, no more than the 0.3s left`);
    // The seek before it takes a few tens of milliseconds; a full fade in would take 2000.
    assert.ok(steps.at(-1)!.at - song < 600, `and was over ${steps.at(-1)!.at - song}ms after the load`);
    const load = mpv.when('loadfile /audio/count.mp3');
    near(mpv.when('pause=no', load) === undefined ? undefined : mpv.when('pause=no', load)! - t0, 1000, 'the countdown on its second');
  });

  test('a block reached late all the same — a stalled server — is skipped whole', async () => {
    const { mpv, runner, clock } = rig();
    const t0 = Date.now();
    const plan = countdownPlan({ at: new Date(t0 - 300), until: new Date(t0 + 3000) }, [
      { track: entry('min', 0.3, 40), at: new Date(t0 + 700) },
      { track: entry('count', 0.3, 40), at: new Date(t0 + 1500) },
    ]);

    assert.deepEqual(runner.startPlan(plan), { ok: true });
    // The block opens at 200ms by the wall; the church clock leaps a second past it meanwhile.
    setTimeout(() => clock.setOffset(1), 100);
    await settle(1800);

    assert.equal(mpv.when('loadfile /audio/min.mp3'), undefined);
    assert.equal(mpv.when('loadfile /audio/count.mp3'), undefined, 'not even the notice still ahead');
    await runner.stop();
  });

  test('after the run\'s music the deck stays the run\'s through the quiet, and goes back once, after the last cue', async () => {
    const { mpv, runner } = rig();
    const t0 = Date.now();
    const plan: Plan = {
      id: 'service', name: '예배 전', lock: { at: new Date(t0 - 500), until: new Date(t0 + 2600) },
      parts: [
        { kind: 'music', tracks: [entry('song', 0.8, 50)], startsAt: new Date(t0 + 200), endsAt: new Date(t0 + 1000) },
        { kind: 'countdown', cues: [{ track: entry('min', 0.4, 40), at: new Date(t0 + 1500) }] },
      ],
    };
    const deck = sampleDeck(runner, t0, [1100, 2100]);

    assert.deepEqual(runner.startPlan(plan), { ok: true });
    await settle(2200);

    const song = mpv.when('loadfile /audio/song.mp3');
    near(song === undefined ? undefined : song - t0, 200, 'the music started');
    // Its block opens 500 before it, at 1000, as the music ends.
    const cue = mpv.when('loadfile /audio/min.mp3');
    near(cue === undefined ? undefined : cue - t0, 1000, 'the cue loaded as its block opened, the music over');
    const backs = mpv.calls.filter((entryCall) => entryCall.call === 'loadfile /audio/calm.mp3' && entryCall.at > song!);
    assert.equal(backs.length, 1, 'the song came back once, not between the music and the cue');
    near(backs[0]!.at - t0, 1900, 'the song came back after the cue');
    assert.deepEqual(deck, { 1100: true, 2100: false });
  });

  test('a stop in the middle of a cue puts the deck back and opens the gate', async () => {
    const { mpv, runner, locks } = rig();
    const t0 = Date.now();
    const plan = countdownPlan({ at: new Date(t0 - 500), until: new Date(t0 + 5000) }, [
      { track: entry('count', 2, 70), at: new Date(t0 + 700) },
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
    const plan = countdownPlan({ at: new Date(t0 - 500), until: new Date(t0 + 1100) }, [
      { track: entry('min', 0.3, 70), at: new Date(t0 + 700) },
    ]);

    assert.deepEqual(runner.startPlan(plan), { ok: true });
    await settle(1000);

    const load = mpv.calls.findIndex((entryCall) => entryCall.call === 'loadfile /audio/min.mp3');
    assert.ok(load > 0);
    const volume = mpv.calls.slice(0, load).reverse().find((entryCall) => entryCall.call.startsWith('volume='))?.call;
    assert.equal(volume, 'volume=0');
  });
});

describe('A timeline with a countdown', () => {
  /** The real lead times: a countdown with a desk keeps 7s of quiet ahead of its first clip, without one 2s. */
  const REAL: FlowTiming = { CUE_PRELOAD_MS: 2000, CUE_GRACE_MS: 500, CUE_DESK_LEAD_MS: 5000, CUE_LEAD_SLACK_MS: 3000 };
  const t = Date.UTC(2026, 9, 25, 10, 0, 0);
  const lock = { at: new Date(t), until: new Date(t + 60_000) };
  const music = { kind: 'music' as const, tracks: [entry('song', 30, 50)], startsAt: new Date(t), endsAt: new Date(t + 30_000) };
  const DESK: DeskChange[] = [{ address: '/auxin/05/mix/st', value: int(0) }];
  const countdown = (desk: DeskChange[] | undefined, ...list: [number, number][]) => ({
    kind: 'countdown' as const,
    cues: list.map(([atMs, sec], i) => ({ track: entry(`cue${i}`, sec, 50), at: new Date(t + atMs) })),
    desk,
  });

  test('its block, from the lead before its first notice, may not overlap the run\'s music', () => {
    assert.equal(m.timelineConflict({ lock, parts: [music, countdown(DESK, [36_000, 2])] }, REAL), 'countdownOverlapsMusic');
    assert.equal(m.timelineConflict({ lock, parts: [music, countdown(DESK, [40_000, 2])] }, REAL), null, 'its block opening as the music ends is fine');
    assert.equal(m.timelineConflict({ lock, parts: [music, countdown(undefined, [34_000, 2])] }, REAL), 'countdownOverlapsMusic', 'without a desk, 5s of lead');
    assert.equal(m.timelineConflict({ lock, parts: [music, countdown(undefined, [35_000, 2])] }, REAL), null);
  });

  test('1분 전 and the count: the block runs from 1분 10초 before 0 to 0, and music must end by its start', () => {
    const zero = t + 100_000;
    const wide = { at: new Date(t), until: new Date(zero) };
    const block = {
      kind: 'countdown' as const,
      cues: [
        { track: entry('min', 1.07, 70), at: new Date(zero - 60_000) },
        { track: entry('count', 12.3, 70), at: new Date(zero - 12_300) },
      ],
      desk: DESK,
    };
    assert.deepEqual(m.countdownBlock({ parts: [block] }, REAL), { opens: zero - 70_000, ends: zero });
    const until = (endsAt: number) => ({ ...music, startsAt: new Date(t), endsAt: new Date(endsAt) });
    assert.equal(m.timelineConflict({ lock: wide, parts: [until(zero - 70_000), block] }, REAL), null, 'music ending 1분 10초 before 0');
    assert.equal(m.timelineConflict({ lock: wide, parts: [until(zero - 69_000), block] }, REAL), 'countdownOverlapsMusic', 'a second later');
  });

  test('no notice may begin before the one ahead of it has ended', () => {
    assert.equal(m.timelineConflict({ lock, parts: [countdown(DESK, [40_000, 2], [41_000, 1])] }, REAL), 'cuesOverlap');
    assert.equal(m.timelineConflict({ lock, parts: [countdown(DESK, [45_000, 1], [31_000, 1])] }, REAL), null, 'given out of order, it is put in order');
  });

  test('its block lies inside the gate, lead included', () => {
    assert.equal(m.timelineConflict({ lock, parts: [countdown(DESK, [59_000, 2])] }, REAL), 'countdownOutsideLock');
    assert.equal(m.timelineConflict({ lock, parts: [countdown(DESK, [9000, 1])] }, REAL), 'countdownOutsideLock');
    assert.equal(m.timelineConflict({ lock, parts: [countdown(DESK, [10_000, 1])] }, REAL), null);
  });

  test('music that began before the gate is counted from the gate', () => {
    const early = { ...music, startsAt: new Date(t - 10_000), endsAt: new Date(t + 5000) };
    assert.equal(m.timelineConflict({ lock, parts: [early, countdown(undefined, [10_000, 1])] }, REAL), null);
    assert.equal(m.timelineConflict({ lock, parts: [early, countdown(undefined, [9000, 1])] }, REAL), 'countdownOverlapsMusic');
  });

  test('is refused by the runner before anything happens', () => {
    const { mpv, runner } = rig();
    mpv.calls = [];
    const now = Date.now();
    const plan: Plan = {
      id: 'x', name: 'x', lock: { at: new Date(now), until: new Date(now + 60_000) },
      parts: [
        { kind: 'music', tracks: [entry('song', 30, 50)], startsAt: new Date(now), endsAt: new Date(now + 30_000) },
        { kind: 'countdown', cues: [{ track: entry('min', 2, 40), at: new Date(now + 30_100) }] },
      ],
    };
    assert.deepEqual(runner.startPlan(plan), { ok: false, reason: 'countdownOverlapsMusic' });
    assert.equal(runner.ownsDeck(), false);
    assert.deepEqual(mpv.calls, []);
  });
});

describe('A countdown for the band alone', () => {
  const two = (n: number): string => String(n).padStart(2, '0');
  const AUX = ['/auxin/05', '/auxin/06'];
  const bandOnly = (): DeskChange[] => [...m.BAND_ONLY.BLOCK, ...m.BAND_ONLY.OPEN];
  type Desk = InstanceType<Modules['MockConsole']>;

  /**
   * The room as read on 2026-10-30 — aux 5/6 off, to main LR, every send switched on,
   * AuxMix sending to every matrix — with the fader off 0 dB and the strips in three
   * mute groups, so that putting back is seen to be whole.
   */
  function seedRoom(desk: Desk): void {
    for (const strip of AUX) {
      desk.set(`${strip}/mix/on`, 0);
      desk.set(`${strip}/mix/fader`, 0.5);
      desk.set(`${strip}/mix/st`, 1);
      desk.set(`${strip}/mix/mono`, 0);
      for (let n = 1; n <= 16; n += 1) desk.set(`${strip}/mix/${two(n)}/on`, 1);
      desk.set(`${strip}/mix/08/level`, 0.75);
      desk.set(`${strip}/grp/mute`, 0b100101);
      desk.set(`${strip}/grp/dca`, 0b1000000);
    }
    for (let n = 1; n <= 6; n += 1) desk.set(`/bus/08/mix/${two(n)}/on`, 1);
    desk.set('/bus/08/mix/02/level', 0.75);
    desk.clearJournal();
  }

  async function values(desk: Desk, addresses: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const address of addresses) out[address] = (await desk.query(address)).value;
    return out;
  }

  const countdown = (t0: number, atMs: number, sec: number, untilMs: number, desk: DeskChange[]): Plan => ({
    id: 'count', name: '카운트다운', lock: { at: new Date(t0 - 500), until: new Date(t0 + untilMs) },
    parts: [{ kind: 'countdown', cues: [{ track: entry('count', sec, 70), at: new Date(t0 + atMs) }], desk }],
  });

  test('1분 전 through the count is one block: the desk set once as it opens and put back once after the count', async () => {
    const { mpv, runner, desk, holds } = rig();
    seedRoom(desk);
    const touched = bandOnly().map((change) => change.address);
    const before = await values(desk, touched);
    const t0 = Date.now();
    const plan: Plan = {
      id: 'count', name: '카운트다운', lock: { at: new Date(t0 - 500), until: new Date(t0 + 3500) },
      parts: [{
        kind: 'countdown',
        cues: [
          { track: entry('min', 0.3, 70), at: new Date(t0 + 1000) },
          { track: entry('count', 0.5, 70), at: new Date(t0 + 2500) },
        ],
        desk: bandOnly(),
      }],
    };
    let between: Record<string, number> = {};
    setTimeout(() => { void values(desk, touched).then((now) => { between = now; }); }, t0 + 1600 - Date.now());
    const sent: { address: string; at: number }[] = [];
    const send = desk.send.bind(desk);
    desk.send = async (address, value) => { sent.push({ address, at: Date.now() }); return send(address, value); };

    assert.deepEqual(runner.startPlan(plan), { ok: true });
    await settle(3300);

    const min = mpv.when('pause=no', mpv.when('loadfile /audio/min.mp3'));
    const count = mpv.when('pause=no', mpv.when('loadfile /audio/count.mp3'));
    assert.ok(min !== undefined && count !== undefined, 'both played');
    const n = touched.length;
    assert.equal(sent.length, n * 2, 'set once and put back once');
    assert.ok(sent.slice(0, n).every((message) => message.at <= min), 'set before 1분 전');
    // An end is a planned instant; a start lands a few milliseconds after its own.
    assert.ok(sent.slice(n).every((message) => message.at >= count + 500 - SLACK_MS), 'put back after the count had ended');
    assert.equal(between['/auxin/05/mix/st'], 0, 'between the notices, still the band\'s alone');
    assert.deepEqual(await values(desk, touched), before, 'and after, the desk as it was');
    holds.dispose();
  });

  test('every way out is shut, then the way in opened, before it sounds; after, the other way round, whole', async () => {
    const { mpv, runner, desk, holds } = rig();
    seedRoom(desk);
    const touched = bandOnly().map((change) => change.address);
    const before = await values(desk, touched);
    const t0 = Date.now();
    let during: Record<string, number> = {};
    setTimeout(() => { void values(desk, touched).then((now) => { during = now; }); }, t0 + 1300 - Date.now());

    assert.deepEqual(runner.startPlan(countdown(t0, 1000, 0.6, 2500, bandOnly())), { ok: true });
    await settle(2000);

    const load = mpv.when('loadfile /audio/count.mp3');
    const sounded = mpv.when('pause=no', load);
    assert.ok(sounded !== undefined, 'the countdown played');
    near(sounded - t0, 1000, 'on its second');
    const sent = desk.snapshot().journal.filter((message) => message.from === 'server');
    const applied = sent.filter((message) => message.at <= sounded);
    const putBack = sent.filter((message) => message.at > sounded);
    assert.deepEqual(applied.map((message) => message.address), touched, 'all of it set, in this order, before it sounded');
    const blocks = new Set(m.BAND_ONLY.BLOCK.map((change) => change.address));
    const lastBlock = applied.map((message) => blocks.has(message.address)).lastIndexOf(true);
    const firstOpen = applied.findIndex((message) => !blocks.has(message.address));
    assert.ok(lastBlock < firstOpen, 'every way out shut before the way in opened');
    assert.deepEqual(putBack.map((message) => message.address), [...touched].reverse(), 'the way in closed before the ways out reopened');

    for (const strip of AUX) {
      assert.equal(during[`${strip}/mix/st`], 0, `${strip} off the main LR`);
      assert.equal(during[`${strip}/mix/mono`], 0);
      for (let n = 1; n <= 16; n += 1) assert.equal(during[`${strip}/mix/${two(n)}/on`], n === 8 ? 1 : 0, `${strip} send ${n}`);
      assert.equal(during[`${strip}/grp/mute`], 0, `${strip} in no mute group`);
      assert.equal(during[`${strip}/grp/dca`], 0, `${strip} in no DCA`);
      assert.equal(during[`${strip}/mix/on`], 1, `${strip} on`);
      assert.equal(Math.abs(dbFromFader(during[`${strip}/mix/fader`]!)), 0, `${strip} at 0 dB`);
    }
    for (let n = 1; n <= 6; n += 1) assert.equal(during[`/bus/08/mix/${two(n)}/on`], 0, `AuxMix to matrix ${n}`);
    assert.equal(during['/bus/08/mix/st'], 0, 'AuxMix off the main LR');
    assert.equal(during['/bus/08/mix/mono'], 0);

    const after = await values(desk, touched);
    assert.deepEqual(after, before, 'the desk as it was');
    assert.equal(after['/auxin/05/grp/mute'], 0b100101, 'back in all three mute groups');
    assert.equal(after['/auxin/05/grp/dca'], 0b1000000, 'back in DCA 7');
    holds.dispose();
  });

  test('a countdown whose desk cannot be set is not played, and nothing is sent to the desk', async () => {
    const { mpv, runner, desk, holds } = rig();
    seedRoom(desk);
    const unreadable: DeskChange = { address: '/ch/99/mix/on', value: int(0) };
    const t0 = Date.now();

    assert.deepEqual(runner.startPlan(countdown(t0, 1000, 0.4, 1700, [...m.BAND_ONLY.BLOCK, unreadable])), { ok: true });
    await settle(1500);

    assert.equal(mpv.when('loadfile /audio/count.mp3'), undefined, 'not played');
    assert.deepEqual(desk.snapshot().journal.filter((message) => message.from === 'server'), [], 'the desk untouched');
    holds.dispose();
  });

  test('a stop while the band\'s countdown sounds puts the desk back', async () => {
    const { runner, desk, holds } = rig();
    seedRoom(desk);
    const touched = bandOnly().map((change) => change.address);
    const before = await values(desk, touched);
    const t0 = Date.now();

    assert.deepEqual(runner.startPlan(countdown(t0, 1000, 3, 6000, bandOnly())), { ok: true });
    await settle(1300);
    assert.equal((await desk.query('/auxin/05/mix/on')).value, 1, 'sounding, the desk set');

    await runner.stop();
    assert.deepEqual(await values(desk, touched), before, 'the desk as it was');
    holds.dispose();
  });
});
