import { io } from 'socket.io-client';
import type { Socket, ManagerOptions, SocketOptions } from 'socket.io-client';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPassword } from '../../server/auth/password.ts';
import { C2S, PROTOCOL_VERSION, S2C } from '../../server/protocol.ts';
import type { RejectReason, S2CPayloads, StatePatch } from '../../server/protocol.ts';

// Note(yoochan.kim): the client Socket stays untyped so rejection tests can emit payloads a typed emit would refuse.

// Note(yoochan.kim): declared test parameters, not hidden fallbacks; env overrides them for an external server.
export const TEST_PORT = Number(process.env.PORT ?? '4000');
export const TEST_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin123';
const TEST_CONSOLE_MODE = process.env.CONSOLE_MODE ?? 'MOCK';
const TEST_LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
// Note(yoochan.kim): X32 config is required at module load even in MOCK mode; supply test values.
const TEST_X32_REMOTE_ADDRESS = process.env.X32_REMOTE_ADDRESS ?? '127.0.0.1';
const TEST_X32_REMOTE_PORT = process.env.X32_REMOTE_PORT ?? '10023';
// Note(yoochan.kim): libmpv path is required at module load (real mpv boots even in MOCK mode).
const TEST_MPV_LIBRARY_PATH = process.env.MPV_LIBRARY_PATH ?? '/opt/homebrew/lib/libmpv.dylib';
// Note(yoochan.kim): Isolate persisted state to a temp file so tests never read/write the real one.
const TEST_STATE_FILE_PATH = process.env.STATE_FILE_PATH ?? path.join(os.tmpdir(), 'cms-test-state.json');
// Note(yoochan.kim): a copy, since a test setting a level would otherwise edit the library this building plays from.
const TEST_TRACKS_SOURCE = process.env.TRACKS_MANIFEST_PATH ?? './assets/tracks.json';
export const TEST_TRACKS_MANIFEST_PATH = path.join(os.tmpdir(), `cms-test-tracks-${process.pid}.json`);
// Note(yoochan.kim): a temp folder, since a deleted track's file goes from here and the real audio lives outside it.
export const TEST_AUDIO_DIR = path.join(os.tmpdir(), `cms-test-audio-${process.pid}`);
/** The one track a test may delete: silent, and in the test's own folder. */
export const SCRATCH_TRACK_ID = 'test-scratch';
export const SCRATCH_TRACK_FILE = path.join(TEST_AUDIO_DIR, 'scratch.mp3');
// Note(yoochan.kim): starts empty for the same reason, so a saved flow never writes the one this building runs on.
const TEST_SCHEDULE_FILE_PATH = path.join(os.tmpdir(), `cms-test-schedule-${process.pid}.json`);
// Note(yoochan.kim): declared here, not read from .env, which keeps a developer's own config out of the test run.
const TEST_ADMIN_CONTACT_NAME = process.env.ADMIN_CONTACT_NAME ?? '테스트 담당자';
const TEST_ADMIN_CONTACT_PHONE = process.env.ADMIN_CONTACT_PHONE ?? '010-0000-0000';
// Note(yoochan.kim): a port nothing answers, so a test reaching the APK relay fails fast instead of downloading.
const TEST_FILESERVER_URL = process.env.FILESERVER_URL ?? 'http://localhost:1';
const TEST_FILESERVER_PASSWORD = process.env.FILESERVER_PASSWORD ?? 'test';
// Note(yoochan.kim): a stand-in, so no test reaches YouTube. The video id picks its answer.
const TEST_YTDLP_PATH = path.resolve('./tests/fixtures/fake-yt-dlp.mjs');

const DEFAULT_TEST_URL = `http://localhost:${TEST_PORT}`;

/** Paths resolved, as the copy no longer sits by its audio; added tracks go last so the first stays the manifest's. */
function copyManifest(): void {
  const dir = path.dirname(TEST_TRACKS_SOURCE);
  const entries = JSON.parse(fs.readFileSync(TEST_TRACKS_SOURCE, 'utf8')) as Record<string, unknown>[];
  const resolved: Record<string, unknown>[] = entries.map((entry) => ({ ...entry, file: path.resolve(dir, String(entry.file)) }));
  fs.mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  fs.copyFileSync(path.resolve('./tests/fixtures/silence.mp3'), SCRATCH_TRACK_FILE);
  resolved.push({ id: SCRATCH_TRACK_ID, title: '테스트 곡', file: SCRATCH_TRACK_FILE, durationSec: 1.1, volume: 50 });
  // Note(yoochan.kim): a countdown's count and two notices, silent, for whichever the manifest has none of.
  const roles = [{ kind: 'count' }, { kind: 'notice', beforeSec: 60 }, { kind: 'notice', beforeSec: 30 }];
  for (const role of roles) {
    if (resolved.some((entry) => JSON.stringify(entry.role) === JSON.stringify(role))) continue;
    const name = role.kind === 'count' ? 'count' : `notice-${role.beforeSec}`;
    const file = path.join(TEST_AUDIO_DIR, `${name}.mp3`);
    fs.copyFileSync(path.resolve('./tests/fixtures/silence.mp3'), file);
    resolved.push({ id: `test-${name}`, title: `테스트 ${name}`, file, durationSec: 1.1, volume: 50, role });
  }
  fs.writeFileSync(TEST_TRACKS_MANIFEST_PATH, JSON.stringify(resolved), 'utf8');
}

/** The slice of MediaServer the test bootstrap needs */
interface StoppableServer {
  start(): void;
  stop(): void;
}

let startedServer: StoppableServer | null = null;

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect({ port, host: '127.0.0.1' });
    const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 500);
    probe.once('connect', () => { clearTimeout(timer); probe.end(); resolve(true); });
    probe.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

/** In-process MOCK server when the port is free (mpv stays paused, so silent); an external server is used as-is. */
export async function ensureServer(): Promise<void> {
  if (await isPortOpen(TEST_PORT)) return;

  // Note(yoochan.kim): every env variable is required, so the test environment is set before the server modules load.
  process.env.PORT = String(TEST_PORT);
  process.env.CONSOLE_MODE = TEST_CONSOLE_MODE;
  // Note(yoochan.kim): The server stores only a hash; auth tests send the matching plaintext.
  process.env.ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH ?? hashPassword(TEST_ADMIN_PASSWORD);
  process.env.LOG_LEVEL = TEST_LOG_LEVEL;
  process.env.X32_REMOTE_ADDRESS = TEST_X32_REMOTE_ADDRESS;
  process.env.X32_REMOTE_PORT = TEST_X32_REMOTE_PORT;
  process.env.MPV_LIBRARY_PATH = TEST_MPV_LIBRARY_PATH;
  process.env.STATE_FILE_PATH = TEST_STATE_FILE_PATH;
  process.env.TRACKS_MANIFEST_PATH = TEST_TRACKS_MANIFEST_PATH;
  process.env.TRACKS_AUDIO_DIR = TEST_AUDIO_DIR;
  process.env.YTDLP_PATH = TEST_YTDLP_PATH;
  process.env.SCHEDULE_FILE_PATH = TEST_SCHEDULE_FILE_PATH;
  process.env.ADMIN_CONTACT_NAME = TEST_ADMIN_CONTACT_NAME;
  process.env.ADMIN_CONTACT_PHONE = TEST_ADMIN_CONTACT_PHONE;
  process.env.FILESERVER_URL = TEST_FILESERVER_URL;
  process.env.FILESERVER_PASSWORD = TEST_FILESERVER_PASSWORD;
  // Note(yoochan.kim): Start from a clean slate so boot uses INITIAL defaults, not a prior run.
  fs.rmSync(TEST_STATE_FILE_PATH, { force: true });
  copyManifest();
  fs.writeFileSync(TEST_SCHEDULE_FILE_PATH, '[]', 'utf8');

  const { default: MediaServer } = await import('../../server/server.ts');
  const server: StoppableServer = new MediaServer();
  server.start();
  startedServer = server;

  for (let i = 0; i < 50; i++) {
    if (await isPortOpen(TEST_PORT)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Test server failed to start on port ${TEST_PORT}`);
}

/** Whether the server under test is in-process, so its files are the temp ones above, not an external server's. */
export function ownsServer(): boolean {
  return startedServer !== null;
}

/** Stops the server only if ensureServer() started it in-process. */
export async function stopServer(): Promise<void> {
  if (startedServer) {
    startedServer.stop();
    startedServer = null;
    fs.rmSync(TEST_TRACKS_MANIFEST_PATH, { force: true });
    fs.rmSync(TEST_SCHEDULE_FILE_PATH, { force: true });
    fs.rmSync(TEST_AUDIO_DIR, { recursive: true, force: true });
  }
}

export class SocketTestHelper {
  readonly url: string;
  readonly options: Partial<ManagerOptions & SocketOptions>;
  socket: Socket | null;

  constructor(url: string = DEFAULT_TEST_URL, options: Partial<ManagerOptions & SocketOptions> = {}) {
    this.url = url;
    this.options = options;
    this.socket = null;
  }

  connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      this.socket = io(this.url, this.options);
      const timer = setTimeout(() => reject(new Error('Connection timeout')), 10000);

      this.socket.on('connect', () => {
        clearTimeout(timer);
        resolve(this.socket!);
      });
      this.socket.on('connect_error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // Note(yoochan.kim): T has no default on purpose, so every call site states the payload type it expects.
  emitAndWaitFor<T>(event: string, responseEvent: string, ...args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No response for ${event}`)), 5000);
      this.socket!.once(responseEvent, (data: T) => {
        clearTimeout(timer);
        resolve(data);
      });
      this.socket!.emit(event, ...args);
    });
  }

  waitFor<T>(responseEvent: string, ms = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No ${responseEvent}`)), ms);
      this.socket!.once(responseEvent, (data: T) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  // Note(yoochan.kim): for asserting an ordered sequence of broadcasts, such as the lock going true then false.
  collectFor<T>(event: string, ms: number): Promise<T[]> {
    return new Promise((resolve) => {
      const received: T[] = [];
      const onEvent = (data: T): void => { received.push(data); };
      this.socket!.on(event, onEvent);
      setTimeout(() => {
        this.socket!.off(event, onEvent);
        resolve(received);
      }, ms);
    });
  }

  // Note(yoochan.kim): resolves true when no responseEvent arrives in time, to assert an operation was blocked.
  emitAndExpectNoResponse(event: string, responseEvent: string, ms: number, ...args: unknown[]): Promise<boolean> {
    return new Promise((resolve) => {
      let received = false;
      const onResponse = (): void => { received = true; };
      this.socket!.on(responseEvent, onResponse);
      this.socket!.emit(event, ...args);
      setTimeout(() => {
        this.socket!.off(responseEvent, onResponse);
        resolve(!received);
      }, ms);
    });
  }

  // --- protocol v1 helpers ---

  /** A client must say hello before the server takes writes or invokes, so nearly every test starts here. */
  async open(client = 'test-client'): Promise<{ ready: S2CPayloads['ready']; state: StatePatch }> {
    await this.connect();
    const readyP = this.waitFor<S2CPayloads['ready']>(S2C.READY);
    const stateP = this.waitFor<StatePatch>(S2C.STATE);
    this.socket!.emit(C2S.HELLO, { client, protocolVersion: PROTOCOL_VERSION });
    return { ready: await readyP, state: await stateP };
  }

  /** Reads every attribute, resolving the state that comes back. */
  read(): Promise<StatePatch> {
    return this.emitAndWaitFor<StatePatch>(C2S.READ, S2C.STATE, {});
  }

  write(field: string, value: unknown): void {
    this.socket!.emit(C2S.WRITE, { field, value });
  }

  invoke(command: string, args: Record<string, unknown> = {}): void {
    this.socket!.emit(C2S.INVOKE, { command, args });
  }

  /** State is one event carrying only what changed, so a test names the change it means, not the event. */
  waitForState(matches: (patch: StatePatch) => boolean, ms = 5000): Promise<StatePatch> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket!.off(S2C.STATE, onState);
        reject(new Error('No matching state patch'));
      }, ms);
      const onState = (patch: StatePatch): void => {
        if (!matches(patch)) return;
        clearTimeout(timer);
        this.socket!.off(S2C.STATE, onState);
        resolve(patch);
      };
      this.socket!.on(S2C.STATE, onState);
    });
  }

  collectStates(ms: number): Promise<StatePatch[]> {
    return this.collectFor<StatePatch>(S2C.STATE, ms);
  }

  waitForRejected(target: string, ms = 2000): Promise<RejectReason> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket!.off(S2C.REJECTED, onRejected);
        reject(new Error(`No rejection for ${target}`));
      }, ms);
      const onRejected = (payload: { target: string; reason: RejectReason }): void => {
        if (payload.target !== target) return;
        clearTimeout(timer);
        this.socket!.off(S2C.REJECTED, onRejected);
        resolve(payload.reason);
      };
      this.socket!.on(S2C.REJECTED, onRejected);
    });
  }

  expectNoState(matches: (patch: StatePatch) => boolean, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let seen = false;
      const onState = (patch: StatePatch): void => { if (matches(patch)) seen = true; };
      this.socket!.on(S2C.STATE, onState);
      setTimeout(() => {
        this.socket!.off(S2C.STATE, onState);
        resolve(!seen);
      }, ms);
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
}
