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

// Note(yoochan.kim): mpv only records and the meter is derived from it, so nothing sounds; modules read env on load.
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
const { int, float, deskAddress } = await import('../../server/console/desk.ts');
const { MeterAverage, volumeFor } = await import('../../server/level/meterAverage.ts');
const { CONSOLE_CONFIG } = await import('../../server/constants/consoleConfig.ts');
const { faderFromDb } = await import('../../server/console/faderLevel.ts');
const MEASURE = CONSOLE_CONFIG.MEASURE_OUTPUT;
const OUTPUT = { kind: 'output' } as const;
const MAIN = '/main/st/mix/on';

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
const STRIPS = ['/auxin/05', '/auxin/06'];
const two = (n: number): string => String(n).padStart(2, '0');
/** The music player as a service has it: on, to the room and every bus, in a mute group and DCA 7, a little down. */
const SERVICE: [string, DeskValue][] = [[MAIN, int(1)], ['/main/st/mix/fader', float(faderFromDb(6))], ...STRIPS.flatMap((strip): [string, DeskValue][] => [
  [`${strip}/mix/on`, int(1)], [`${strip}/mix/st`, int(1)], [`${strip}/mix/fader`, float(0.6)],
  [`${strip}/grp/mute`, int(0b1)], [`${strip}/grp/dca`, int(0b1000000)],
  ...Array.from({ length: 16 }, (_, i): [string, DeskValue] => [`${strip}/mix/${two(i + 1)}/on`, int(1)]),
])];
/** The song's meter reading at volume 100 (-6 dB). At 50, 20 dB under, it reads -26 dB. */
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

/** A desk with the music player live on it, sending meters every 10ms while asked to; what nobody set reads 0. */
class MeterDesk implements ConsoleDevice {
  readonly values = new Map<string, DeskValue>(SERVICE);
  sendsMeters = true;
  private readonly wire: ((address: string, value: DeskValue) => void)[] = [];
  /** One frame to each listener, read off the meter it asked for. */
  private readonly meters = new Set<() => void>();
  private timer: NodeJS.Timeout | null = null;
  /** Which meter each listener asked for. */
  readonly watched: string[] = [];

  constructor(private readonly mpv: FakeMpv, private readonly events: string[]) {}

  async query(address: string): Promise<DeskValue> {
    const known = deskAddress(address);
    if (!known) throw new Error(`no ${address}`);
    return this.values.get(address) ?? (known.kind === 'level' ? float(0) : int(0));
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

  watchMeters(kind: 'output' | 'main', listener: (levels: readonly number[]) => void): () => void {
    this.watched.push(kind);
    // Note(yoochan.kim): both are pre-fade, so no mute silences them; the main has the track while it is sent there.
    const frame = (): void => {
      const level = kind === 'main' && this.values.get('/auxin/05/mix/st')?.value !== 1 ? 0 : this.mpv.meter();
      listener([level, level]);
    };
    this.meters.add(frame);
    if (this.sendsMeters && !this.timer) {
      this.timer = setInterval(() => {
        for (const meter of this.meters) meter();
      }, 10);
    }
    return () => {
      this.meters.delete(frame);
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
  return { id, title: id, file: `/audio/${id}.mp3`, declaredFile: `./audio/${id}.mp3`, durationSec, volume, userSelectable: false, role: { kind: 'music' } };
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
  const desks = { output: MEASURE, mainMuted: CONSOLE_CONFIG.MEASURE_MAIN_MUTED };
  const matcher = new LevelMatcher(player, library, lock, notifier, new MixerConsole(desk, holds), flow, desks, TIMING);

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
    // Note(yoochan.kim): a frame every 50ms, both channels alike, as the desk sends them.
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

    // Note(yoochan.kim): the loud halves alone, power-averaged: 10·log10((10^-2 + 10^-1.8) / 2) = -18.9 dB.
    const average = meter.averageDb()!;
    assert.ok(Math.abs(average - -18.9) < 0.2, `averaged ${average.toFixed(2)} dB`);
  });

  test('nothing loud enough to count is no answer, not a quiet one', () => {
    const meter = new MeterAverage();
    for (let at = 0; at < 5000; at += 50) meter.add([0, 0], at);
    assert.equal(meter.averageDb(), null);
  });

  test('a level is decibels on the fader\'s curve: 50 is 20 dB under 100', () => {
    assert.equal(Math.round(volumeFor(100, 0, -20)), 50);
    assert.equal(Math.round(volumeFor(50, -26, -30)), 43);
  });
});

describe('Measuring a track on the desk', () => {
  test('plays it with every way out of the music player shut and its strip muted, then says the level that lands it on the target, applied only when asked', async () => {
    const { events, patches, tracks, player, desk, holds, matcher, finished } = rig();
    const touched = [...new Set(MEASURE.map((change) => change.address))];
    const read = async (): Promise<Record<string, number>> =>
      Object.fromEntries(await Promise.all(touched.map(async (address) => [address, (await desk.query(address)).value])));
    const before = await read();
    let whilePlaying: Record<string, number> | undefined;
    const watch = setInterval(() => {
      if (player.isPlaying() && !whilePlaying) whilePlaying = Object.fromEntries(touched.map((address) => [address, desk.values.get(address)?.value ?? 0]));
    }, 2);

    assert.deepEqual(matcher.start({ track: 'hymn', meter: OUTPUT, targetDb: -30, span: { kind: 'whole' } }), { ok: true });
    const result = await finished();
    clearInterval(watch);

    assert.ok(whilePlaying, 'it played');
    for (const strip of STRIPS) {
      assert.equal(whilePlaying[`${strip}/mix/st`], 0, `${strip} off the room`);
      assert.equal(whilePlaying[`${strip}/mix/mono`], 0, `${strip} off the mono`);
      for (let n = 1; n <= 16; n += 1) assert.equal(whilePlaying[`${strip}/mix/${two(n)}/on`], 0, `${strip} off bus ${n}, AuxMix included`);
      assert.equal(whilePlaying[`${strip}/mix/on`], 0, `${strip} muted, its meter read before the mute`);
    }
    const sent = events.filter((event) => event.startsWith('desk '));
    assert.ok(!sent.some((event) => /\/(grp|mix\/fader)/.test(event)), 'its groups, DCA and fader left alone');
    assert.deepEqual(await read(), before, 'the desk as it was, the music player live to the room again');
    const load = events.indexOf('deck load /audio/hymn.mp3');
    const muted = events.indexOf('desk /auxin/06/mix/on=0');
    assert.ok(events.findIndex((event) => event.startsWith('desk /auxin/05/mix/16/on=')) < muted, 'every send shut before the strip is muted');
    assert.ok(muted !== -1 && muted < load, 'all of it set before the track loads');
    const stopped = events.findIndex((event, at) => at > load && event === 'deck pause=yes');
    const putBack = events.findIndex((event, at) => at > load && event.startsWith('desk '));
    assert.ok(stopped !== -1 && stopped < putBack, 'the track stopped before any of the desk went back');
    assert.ok(result.phase === 'measured');
    assert.equal(result.volumeBefore, 50);
    assert.deepEqual(result.answer, { kind: 'reachable', averageDb: -26, volumeAfter: 43 });
    assert.equal(tracks.get('hymn')!.volume, 50, 'nothing changed by measuring');

    const progress = patches.flatMap((patch) => (patch.levelMatch?.phase === 'measuring' ? [patch.levelMatch] : []));
    assert.equal(progress[0]?.stage, 'settingDesk', 'the desk set first');
    assert.equal(progress[0]?.averageDb, -120, 'no average while the desk is being set');
    assert.ok(progress.some((step) => step.stage === 'playing' && step.averageDb === -26), 'the average so far told while it plays');

    assert.deepEqual(matcher.apply(), { ok: true });
    assert.equal(tracks.get('hymn')!.volume, 43);
    const done = matcher.current();
    assert.ok(done.phase === 'done');
    assert.equal(done.volumeAfter, 43);
    const told = patches.find((patch) => patch.levelMatch?.phase === 'done')!;
    assert.equal(told.tracks?.find((track) => track.id === 'hymn')?.volume, 43, 'the new level arrives with the result');

    assert.deepEqual(matcher.revert(), { ok: true });
    assert.equal(tracks.get('hymn')!.volume, 50, 'the old level back');
    assert.equal(matcher.current().phase, 'measured', 'and the answer can be applied again');
    assert.deepEqual(matcher.revert(), { ok: false, reason: RejectReason.NOT_MEASURING });
    assert.deepEqual(player.getDeck(), { source: 'song' });
    assert.equal(player.getState(), PlaybackState.PAUSED);
    assert.deepEqual(desk.watched, ['output'], 'read off the music player\'s own meter');
    assert.deepEqual(result.meter, OUTPUT);
    holds.dispose();
  });

  test('the main, muted: only the main is switched off while it plays, then put back, and the main meter read', async () => {
    const { events, player, desk, holds, matcher, finished } = rig();
    let mainWhilePlaying: number | undefined;
    const watch = setInterval(() => {
      if (player.isPlaying() && mainWhilePlaying === undefined) mainWhilePlaying = desk.values.get(MAIN)!.value;
    }, 2);

    const meter = { kind: 'main', mute: true } as const;
    assert.deepEqual(matcher.start({ track: 'hymn', meter, targetDb: -30, span: { kind: 'whole' } }), { ok: true });
    const result = await finished();
    clearInterval(watch);

    assert.equal(mainWhilePlaying, 0, 'the room spared while it played');
    assert.equal(desk.values.get(MAIN)!.value, 1, 'the main back on');
    const sent = events.filter((event) => event.startsWith('desk ')).map((event) => event.slice(5, event.indexOf('=')));
    assert.deepEqual([...new Set(sent)], [MAIN], 'nothing on the desk but the main');
    assert.deepEqual(desk.watched, ['main']);
    assert.ok(result.phase === 'measured' && result.answer.kind === 'reachable');
    assert.deepEqual(result.meter, meter);
    assert.equal(result.answer.averageDb, -20, 'read before the main\'s mute, and its fader\'s +6 dB added: the output\'s -26 plus 6');
    holds.dispose();
  });

  test('the main, heard: nothing sent to the desk, and the main meter read', async () => {
    const { events, desk, holds, matcher, finished } = rig();

    const meter = { kind: 'main', mute: false } as const;
    matcher.start({ track: 'hymn', meter, targetDb: -30, span: { kind: 'whole' } });
    const result = await finished();

    assert.deepEqual(events.filter((event) => event.startsWith('desk ')), [], 'the desk left as it is');
    assert.deepEqual(desk.watched, ['main']);
    assert.ok(result.phase === 'measured' && result.answer.kind === 'reachable');
    assert.deepEqual(result.meter, meter);
    assert.equal(result.answer.averageDb, -20, 'the main fader\'s +6 dB added');
    holds.dispose();
  });

  test('plays nothing at all when the desk sends no meters', async () => {
    const { events, desk, holds, matcher, finished } = rig();
    desk.sendsMeters = false;

    matcher.start({ track: 'hymn', meter: OUTPUT, targetDb: -30, span: { kind: 'whole' } });
    const result = await finished();

    assert.deepEqual(result, {
      phase: 'failed', track: 'hymn', meter: OUTPUT, targetDb: -30, elapsedSec: 0, totalSec: 0.5, volumeBefore: 50, why: LevelFailure.DESK_SILENT,
    });
    assert.ok(!events.includes('deck load /audio/hymn.mp3'), 'the track was never loaded');
    assert.ok(!events.includes('deck pause=no'), 'and nothing ever played');
    assert.equal(desk.values.get(AUX_ON)!.value, 1);
    holds.dispose();
  });

  test('is refused unless a person holds the gate with the deck quiet and unmuted', async () => {
    const { player, lock, holds, matcher, finished } = rig();
    const start = (args: Record<string, unknown>) => matcher.start({ track: 'hymn', meter: OUTPUT, targetDb: -30, span: { kind: 'whole' }, ...args });

    assert.deepEqual(start({ targetDb: 6 }), { ok: false, reason: RejectReason.INVALID_VALUE });
    assert.deepEqual(start({ span: { kind: 'first', sec: 0 } }), { ok: false, reason: RejectReason.INVALID_VALUE });
    assert.deepEqual(start({ meter: { kind: 'main' } }), { ok: false, reason: RejectReason.INVALID_VALUE }, 'the main, its mute not chosen');
    assert.deepEqual(start({ meter: { kind: 'aux' } }), { ok: false, reason: RejectReason.INVALID_VALUE });
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

  test('a hand opening a way out at the desk ends it, the track stopped before the desk is put back', async () => {
    const { events, player, desk, holds, matcher, finished } = rig();

    matcher.start({ track: 'hymn', meter: OUTPUT, targetDb: -30, span: { kind: 'whole' } });
    while (!player.isPlaying()) await settle(2);
    const handAt = events.length;
    desk.hand('/auxin/05/mix/st', int(1));
    const result = await finished();

    assert.ok(result.phase === 'failed');
    assert.equal(result.why, LevelFailure.DESK_MOVED);
    const stopped = events.findIndex((event, at) => at >= handAt && event === 'deck pause=yes');
    const putBack = events.findIndex((event, at) => at >= handAt && event.startsWith('desk '));
    assert.ok(stopped !== -1 && stopped < putBack, 'the track stopped before any of the desk went back');
    holds.dispose();
  });

  test('releasing the gate ends it, and a run taking the gate keeps the deck it took', async () => {
    const released = rig();
    released.matcher.start({ track: 'hymn', meter: OUTPUT, targetDb: -30, span: { kind: 'whole' } });
    while (!released.player.isPlaying()) await settle(2);
    released.lock.setAdminLock(false);
    const ended = await released.finished();
    assert.ok(ended.phase === 'failed' && ended.why === LevelFailure.GATE_RELEASED);
    released.holds.dispose();

    const taken = rig();
    taken.matcher.start({ track: 'hymn', meter: OUTPUT, targetDb: -30, span: { kind: 'whole' } });
    while (!taken.player.isPlaying()) await settle(2);
    taken.lock.setAdminLock(true, 'flow');
    taken.flow.owns = true;
    const lost = await taken.finished();
    assert.ok(lost.phase === 'failed' && lost.why === LevelFailure.GATE_RELEASED);
    assert.equal(taken.player.getDeck().source, 'track', 'the run\'s deck is not the measurement\'s to put back');
    assert.equal(taken.desk.values.get(AUX_ON)!.value, 1, 'but the desk is, so the run can be heard');
    taken.holds.dispose();
  });

  test('stopping pauses it where it is, the deck and the desk still its own; it goes on from there, and set aside changes nothing', async () => {
    const { events, tracks, player, desk, holds, matcher, finished } = rig();
    const putBack = async (): Promise<void> => {
      while (matcher.ownsDeck()) await settle(5);
    };

    matcher.start({ track: 'other', meter: OUTPUT, targetDb: -30, span: { kind: 'whole' } });
    while (!player.isPlaying()) await settle(2);
    await settle(80);
    assert.deepEqual(matcher.stop(), { ok: true });
    const paused = await finished();

    assert.ok(paused.phase === 'paused');
    assert.equal(paused.answer.kind, 'reachable', 'what it has heard so far is an answer');
    assert.equal(events.at(-1), 'deck pause=yes', 'the track stopped');
    assert.equal(player.isPlaying(), false);
    assert.deepEqual(player.getDeck(), { source: 'track', id: 'other' }, 'still on the deck');
    assert.equal(desk.values.get(AUX_ON)!.value, 0, 'the desk still as the measurement set it');
    assert.equal(matcher.isPlaying(), false, 'so the gate\'s lapse does not wait on it');
    assert.equal(matcher.ownsDeck(), true);
    assert.deepEqual(matcher.stop(), { ok: false, reason: RejectReason.NOT_MEASURING });
    assert.deepEqual(matcher.start({ track: 'hymn', meter: OUTPUT, targetDb: -30, span: { kind: 'whole' } }), { ok: false, reason: RejectReason.LEVEL_MATCHING });

    assert.deepEqual(matcher.resume(), { ok: true });
    while (!player.isPlaying()) await settle(2);
    assert.deepEqual(matcher.resume(), { ok: false, reason: RejectReason.NOT_MEASURING });
    await settle(80);
    assert.deepEqual(matcher.stop(), { ok: true });
    const again = await finished();
    assert.ok(again.phase === 'paused');
    assert.ok(again.elapsedSec >= paused.elapsedSec, 'it went on from where it stopped');
    assert.equal(events.filter((event) => event === 'deck load /audio/other.mp3').length, 1, 'not loaded again');

    assert.deepEqual(matcher.cancel(), { ok: true });
    await putBack();
    assert.deepEqual(matcher.current(), { phase: 'idle' });
    assert.equal(tracks.get('other')!.volume, 30);
    assert.equal(desk.values.get(AUX_ON)!.value, 1, 'the desk put back');
    assert.deepEqual(player.getDeck(), { source: 'song' });
    holds.dispose();
  });

  test('a paused one applied is ended first, and its level written', async () => {
    const { tracks, player, desk, holds, matcher, finished } = rig();

    matcher.start({ track: 'other', meter: OUTPUT, targetDb: -30, span: { kind: 'whole' } });
    while (!player.isPlaying()) await settle(2);
    await settle(80);
    matcher.stop();
    const paused = await finished();
    assert.ok(paused.phase === 'paused' && paused.answer.kind === 'reachable');

    assert.deepEqual(matcher.apply(), { ok: true });
    while (matcher.ownsDeck()) await settle(5);
    const done = matcher.current();
    assert.ok(done.phase === 'done');
    assert.equal(done.volumeAfter, paused.answer.volumeAfter);
    assert.equal(tracks.get('other')!.volume, paused.answer.volumeAfter);
    assert.equal(desk.values.get(AUX_ON)!.value, 1);
    assert.deepEqual(player.getDeck(), { source: 'song' });
    holds.dispose();
  });

  test('stopped while the desk is being set, nothing sounds until it goes on', async () => {
    const { events, holds, matcher, finished } = rig();

    matcher.start({ track: 'hymn', meter: OUTPUT, targetDb: -30, span: { kind: 'whole' } });
    assert.deepEqual(matcher.stop(), { ok: true });
    const paused = await finished();

    assert.ok(paused.phase === 'paused');
    assert.deepEqual(paused.answer, { kind: 'none' });
    assert.ok(!events.includes('deck load /audio/hymn.mp3'), 'nothing loaded');
    assert.deepEqual(matcher.apply(), { ok: false, reason: RejectReason.INVALID_VALUE }, 'nothing heard is nothing to apply');

    matcher.resume();
    while (matcher.current().phase === 'paused') await settle(2);
    const result = await finished();
    assert.ok(result.phase === 'measured');
    assert.ok(events.includes('deck load /audio/hymn.mp3'), 'played from its start once it went on');
    holds.dispose();
  });

  test('a target the deck cannot reach is reported, cannot be applied, and changes nothing', async () => {
    const { tracks, holds, matcher, finished } = rig();

    matcher.start({ track: 'hymn', meter: OUTPUT, targetDb: 0, span: { kind: 'first', sec: 0.3 } });
    const result = await finished();

    assert.ok(result.phase === 'measured' && result.answer.kind === 'outOfReach');
    assert.ok(result.answer.volumeNeeded > 100);
    assert.deepEqual(matcher.apply(), { ok: false, reason: RejectReason.OUT_OF_REACH });
    assert.equal(tracks.get('hymn')!.volume, 50);
    assert.deepEqual(matcher.cancel(), { ok: true });
    assert.deepEqual(matcher.current(), { phase: 'idle' });
    holds.dispose();
  });

  test('the deck it found comes back — a track a person had put on, with their loop setting', async () => {
    const { tracks, player, holds, matcher, finished } = rig();
    player.setLoop(false);
    await player.selectTrack(tracks.get('other')!, 30, false);

    matcher.start({ track: 'hymn', meter: OUTPUT, targetDb: -30, span: { kind: 'first', sec: 0.3 } });
    await finished();

    assert.deepEqual(player.getDeck(), { source: 'track', id: 'other' });
    assert.equal(player.getLoop(), false);
    assert.equal(player.getState(), PlaybackState.PAUSED);
    holds.dispose();
  });
});
