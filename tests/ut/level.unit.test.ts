import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { LevelFailure, MuteState, PlaybackState, RejectReason } from '../../server/protocol.ts';
import type { LevelMatch, StatePatch } from '../../server/protocol.ts';
import type MpvClient from '../../server/hardware/MpvClient.ts';
import type Notifier from '../../server/notify/Notifier.ts';
import type TrackLibrary from '../../server/tracks/TrackLibrary.ts';
import type { LibraryEntry } from '../../server/tracks/TrackLibrary.ts';
import type { ConsoleDevice } from '../../server/console/ConsoleDevice.ts';
import type { DeskValue } from '../../server/console/desk.ts';
import type { LevelTiming } from '../../server/constants/levelConfig.ts';

// Note(yoochan.kim): nothing here can make a sound. mpv is a stand-in that only
// writes down what it was told, and the desk's meter is worked out from that —
// what the meter would read if the room could hear it. Env first, imports after,
// since the modules read it as they load.
process.env.LOG_LEVEL ??= 'warn';
process.env.CONSOLE_MODE ??= 'MOCK';
process.env.MPV_LIBRARY_PATH ??= '/opt/homebrew/lib/libmpv.dylib';
process.env.X32_REMOTE_ADDRESS ??= '127.0.0.1';
process.env.X32_REMOTE_PORT ??= '10023';

const { default: Player } = await import('../../server/player/Player.ts');
const { default: AudioDevice } = await import('../../server/hardware/AudioDevice.ts');
const { default: LockCoordinator } = await import('../../server/lock/LockCoordinator.ts');
const { default: DeskHolds } = await import('../../server/console/DeskHolds.ts');
const { default: MixerConsole } = await import('../../server/console/MixerConsole.ts');
const { default: LevelMatcher } = await import('../../server/level/LevelMatcher.ts');
const { int } = await import('../../server/console/desk.ts');
const { MeterAverage, volumeFor } = await import('../../server/level/meterAverage.ts');

const TIMING: LevelTiming = {
  TICK_MS: 5,
  PROGRESS_INTERVAL_MS: 30,
  METER_WAIT_MS: 150,
  METER_SILENCE_MS: 150,
  END_SLACK_SEC: 0.05,
  RECENT_SEC: 0.2,
};
const HOLD_TIMING = { CONFIRM_ATTEMPTS: 2, CONFIRM_GAP_MS: 5, RESTORE_RETRY_MS: 20 };

const AUX_ON = '/auxin/05/mix/on';
/** The song's meter reading at volume 100. At 50 the cubic curve puts it at -24.1 dB. */
const SONG_AT_FULL = 0.5;

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeMpv {
  readonly props: Record<string, string> = { volume: '40', 'playback-time': '0', 'idle-active': 'no', pause: 'yes' };

  constructor(private readonly events: string[]) {}

  setProperty(property: string, value: string): void {
    if (property === 'pause') this.events.push(`deck pause=${value}`);
    this.props[property] = value;
  }

  getProperty(property: string): string | null {
    return this.props[property] ?? null;
  }

  executeCommand(command: (string | null)[]): void {
    if (command[0] === 'loadfile') this.events.push(`deck load ${command[1]}`);
  }

  /** What the desk's input would read: the song, as loud as the device was told, while it plays. */
  meter(): number {
    if (this.props.pause !== 'no') return 0;
    return SONG_AT_FULL * (Number(this.props.volume) / 100) ** 3;
  }
}

/** A desk with the music player's input on it, sending meters every 10ms while asked to. */
class MeterDesk implements ConsoleDevice {
  readonly values = new Map<string, DeskValue>([[AUX_ON, int(1)]]);
  sendsMeters = true;
  private readonly wire: ((address: string, value: DeskValue) => void)[] = [];
  private readonly meters = new Set<(levels: readonly number[]) => void>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly mpv: FakeMpv, private readonly events: string[]) {}

  async query(address: string): Promise<DeskValue> {
    const value = this.values.get(address);
    if (!value) throw new Error(`no ${address}`);
    return value;
  }

  async send(address: string, value: DeskValue): Promise<void> {
    this.events.push(`desk ${address}=${value.value}`);
    this.values.set(address, value);
  }

  onWire(listener: (address: string, value: DeskValue) => void): void {
    this.wire.push(listener);
  }

  hand(address: string, value: DeskValue): void {
    this.values.set(address, value);
    for (const listener of this.wire) listener(address, value);
  }

  watchMeters(listener: (levels: readonly number[]) => void): () => void {
    this.meters.add(listener);
    if (this.sendsMeters && !this.timer) {
      this.timer = setInterval(() => {
        const level = this.mpv.meter();
        for (const meter of this.meters) meter([level, level]);
      }, 10);
    }
    return () => {
      this.meters.delete(listener);
      if (this.meters.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  async enable(): Promise<void> {}
  async initialize(): Promise<void> {}
  read(): [] { return []; }
  onChange(): void {}
}

function entry(id: string, durationSec: number, volume: number): LibraryEntry {
  return { id, title: id, file: `/audio/${id}.mp3`, declaredFile: `./audio/${id}.mp3`, durationSec, volume, userSelectable: false };
}

function rig() {
  const events: string[] = [];
  const patches: StatePatch[] = [];
  const notifier = new Proxy({ state: (patch: StatePatch) => { patches.push(patch); } }, {
    get: (target, key) => (key in target ? target[key as 'state'] : () => {}),
  }) as unknown as Notifier;

  const tracks = new Map([
    ['hymn', entry('hymn', 0.5, 50)],
    ['other', entry('other', 60, 30)],
  ]);
  const library = {
    get: (id: string) => tracks.get(id),
    list: () => [...tracks.values()].map(({ id, title, durationSec, volume }) => ({ id, title, durationSec, volume })),
    setVolume: (id: string, volume: number) => { tracks.get(id)!.volume = volume; },
  } as unknown as TrackLibrary;

  const mpv = new FakeMpv(events);
  const player = new Player(
    new AudioDevice(mpv as unknown as MpvClient, 'calm', { calm: '/audio/calm.mp3' }),
    { serverVolume: 40, muted: MuteState.UNMUTED, state: PlaybackState.PAUSED, currentSong: 'calm' },
    () => 40,
    () => {},
  );
  const lock = new LockCoordinator(notifier);
  const desk = new MeterDesk(mpv, events);
  const holds = new DeskHolds(desk, HOLD_TIMING, () => {}, []);
  const flow = { owns: false, ownsDeck: () => flow.owns };
  const matcher = new LevelMatcher(player, library, lock, notifier, new MixerConsole(desk, holds), flow, TIMING);

  lock.setAdminLock(true, 'person');
  const finished = async (): Promise<LevelMatch> => {
    for (let waited = 0; matcher.current().phase === 'measuring'; waited += 5) {
      if (waited > 3000) throw new Error('the measurement never finished');
      await settle(5);
    }
    await settle(30);
    return matcher.current();
  };
  return { events, patches, tracks, mpv, player, lock, desk, holds, flow, matcher, finished };
}

describe('Averaging a meter', () => {
  test('silence and a quiet passage leave the average where the song is', () => {
    const meter = new MeterAverage();
    const amplitude = (db: number): number => 10 ** (db / 20);
    let at = 0;
    // A frame every 50ms, both channels alike, as the desk sends them.
    const play = (db: number | null, sec: number): void => {
      for (let frame = 0; frame < sec * 20; frame += 1, at += 50) {
        const level = db === null ? 0 : amplitude(db);
        meter.add([level, level], at);
      }
    };

    play(null, 5);
    play(-20, 30);
    play(-45, 10);
    play(-18, 30);
    play(null, 5);

    // The loud halves alone, power-averaged: 10·log10((10^-2 + 10^-1.8) / 2) = -18.9 dB.
    const average = meter.averageDb()!;
    assert.ok(Math.abs(average - -18.9) < 0.2, `averaged ${average.toFixed(2)} dB`);
  });

  test('nothing loud enough to count is no answer, not a quiet one', () => {
    const meter = new MeterAverage();
    for (let at = 0; at < 5000; at += 50) meter.add([0, 0], at);
    assert.equal(meter.averageDb(), null);
  });

  test('the volume follows mpv\'s cubic curve: half the volume is 18 dB down', () => {
    assert.equal(Math.round(volumeFor(100, 0, 60 * Math.log10(0.5))), 50);
    assert.equal(Math.round(volumeFor(50, -24.1, -30)), 40);
  });
});

describe('Measuring a track on the desk', () => {
  test('plays it with the input switched off, then moves its level onto the target', async () => {
    const { events, patches, tracks, player, desk, holds, matcher, finished } = rig();
    let inputWhilePlaying: number | undefined;
    const watch = setInterval(() => {
      if (player.isPlaying()) inputWhilePlaying = desk.values.get(AUX_ON)!.value;
    }, 2);

    assert.deepEqual(matcher.start({ track: 'hymn', targetDb: -30, span: { kind: 'whole' } }), { ok: true });
    const result = await finished();
    clearInterval(watch);

    assert.equal(inputWhilePlaying, 0, 'the music player\'s input was off while the track played');
    assert.equal(desk.values.get(AUX_ON)!.value, 1, 'and on again afterwards');
    assert.equal(result.phase, 'done');
    assert.ok(result.phase === 'done');
    assert.equal(result.volumeBefore, 50);
    assert.equal(result.averageDb, -24.1);
    assert.equal(result.volumeAfter, 40);
    assert.equal(tracks.get('hymn')!.volume, 40);

    const told = patches.find((patch) => patch.levelMatch?.phase === 'done')!;
    assert.equal(told.tracks?.find((track) => track.id === 'hymn')?.volume, 40, 'the new level arrives with the result');
    assert.deepEqual(player.getDeck(), { source: 'song' });
    assert.equal(player.getState(), PlaybackState.PAUSED);
    assert.ok(events.indexOf('desk /auxin/05/mix/on=0') < events.indexOf('deck load /audio/hymn.mp3'));
    holds.dispose();
  });

  test('plays nothing at all when the desk sends no meters', async () => {
    const { events, desk, holds, matcher, finished } = rig();
    desk.sendsMeters = false;

    matcher.start({ track: 'hymn', targetDb: -30, span: { kind: 'whole' } });
    const result = await finished();

    assert.deepEqual(result, { phase: 'failed', track: 'hymn', why: LevelFailure.DESK_SILENT });
    assert.ok(!events.includes('deck load /audio/hymn.mp3'), 'the track was never loaded');
    assert.ok(!events.includes('deck pause=no'), 'and nothing ever played');
    assert.equal(desk.values.get(AUX_ON)!.value, 1);
    holds.dispose();
  });

  test('is refused unless a person holds the gate with the deck quiet and unmuted', async () => {
    const { player, lock, holds, matcher, finished } = rig();
    const start = (args: Record<string, unknown>) => matcher.start({ track: 'hymn', targetDb: -30, span: { kind: 'whole' }, ...args });

    assert.deepEqual(start({ targetDb: 6 }), { ok: false, reason: RejectReason.INVALID_VALUE });
    assert.deepEqual(start({ span: { kind: 'first', sec: 0 } }), { ok: false, reason: RejectReason.INVALID_VALUE });
    assert.deepEqual(start({ track: 'nothing' }), { ok: false, reason: RejectReason.UNKNOWN_TRACK });

    player.setMute(MuteState.MUTED);
    assert.deepEqual(start({}), { ok: false, reason: RejectReason.DECK_MUTED });
    player.setMute(MuteState.UNMUTED);

    lock.setAdminLock(true, 'flow');
    assert.deepEqual(start({}), { ok: false, reason: RejectReason.FLOW_ACTIVE });
    lock.setAdminLock(false);
    assert.deepEqual(start({}), { ok: false, reason: RejectReason.ADMIN_UNLOCKED });
    lock.setAdminLock(true, 'person');

    assert.deepEqual(start({}), { ok: true });
    assert.deepEqual(start({}), { ok: false, reason: RejectReason.LEVEL_MATCHING });
    await finished();
    holds.dispose();
  });

  test('a hand switching the input on at the desk ends it, the track stopped before the desk is put back', async () => {
    const { events, player, desk, holds, matcher, finished } = rig();

    matcher.start({ track: 'hymn', targetDb: -30, span: { kind: 'whole' } });
    while (!player.isPlaying()) await settle(2);
    desk.hand(AUX_ON, int(1));
    const result = await finished();

    assert.deepEqual(result, { phase: 'failed', track: 'hymn', why: LevelFailure.DESK_MOVED });
    assert.ok(events.lastIndexOf('deck pause=yes') < events.lastIndexOf('desk /auxin/05/mix/on=1'));
    holds.dispose();
  });

  test('releasing the gate ends it, and a run taking the gate keeps the deck it took', async () => {
    const released = rig();
    released.matcher.start({ track: 'hymn', targetDb: -30, span: { kind: 'whole' } });
    while (!released.player.isPlaying()) await settle(2);
    released.lock.setAdminLock(false);
    assert.deepEqual(await released.finished(), { phase: 'failed', track: 'hymn', why: LevelFailure.GATE_RELEASED });
    released.holds.dispose();

    const taken = rig();
    taken.matcher.start({ track: 'hymn', targetDb: -30, span: { kind: 'whole' } });
    while (!taken.player.isPlaying()) await settle(2);
    taken.lock.setAdminLock(true, 'flow');
    taken.flow.owns = true;
    assert.deepEqual(await taken.finished(), { phase: 'failed', track: 'hymn', why: LevelFailure.GATE_RELEASED });
    assert.equal(taken.player.getDeck().source, 'track', 'the run\'s deck is not the measurement\'s to put back');
    assert.equal(taken.desk.values.get(AUX_ON)!.value, 1, 'but the desk is, so the run can be heard');
    taken.holds.dispose();
  });

  test('stopping it changes nothing', async () => {
    const { tracks, player, holds, matcher, finished } = rig();

    matcher.start({ track: 'hymn', targetDb: -30, span: { kind: 'whole' } });
    while (!player.isPlaying()) await settle(2);
    assert.deepEqual(matcher.stop(), { ok: true });

    assert.deepEqual(await finished(), { phase: 'failed', track: 'hymn', why: LevelFailure.STOPPED });
    assert.equal(tracks.get('hymn')!.volume, 50);
    assert.deepEqual(matcher.stop(), { ok: false, reason: RejectReason.NOT_MEASURING });
    holds.dispose();
  });

  test('a target the deck cannot reach is reported and changes nothing', async () => {
    const { tracks, holds, matcher, finished } = rig();

    matcher.start({ track: 'hymn', targetDb: 0, span: { kind: 'first', sec: 0.3 } });
    const result = await finished();

    assert.equal(result.phase, 'outOfReach');
    assert.ok(result.phase === 'outOfReach' && result.volumeNeeded > 100);
    assert.equal(tracks.get('hymn')!.volume, 50);
    holds.dispose();
  });

  test('the deck it found comes back — a track a person had put on, with their loop setting', async () => {
    const { tracks, player, holds, matcher, finished } = rig();
    player.setLoop(false);
    await player.selectTrack(tracks.get('other')!, 30, false);

    matcher.start({ track: 'hymn', targetDb: -30, span: { kind: 'first', sec: 0.3 } });
    await finished();

    assert.deepEqual(player.getDeck(), { source: 'track', id: 'other' });
    assert.equal(player.getLoop(), false);
    assert.equal(player.getState(), PlaybackState.PAUSED);
    holds.dispose();
  });
});
