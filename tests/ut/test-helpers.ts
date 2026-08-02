import { io } from 'socket.io-client';
import type { Socket, ManagerOptions, SocketOptions } from 'socket.io-client';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPassword } from '../../server/auth/password.ts';
import { C2S, PROTOCOL_VERSION, S2C } from '../../server/protocol.ts';
import type { RejectReason, S2CPayloads, StatePatch } from '../../server/protocol.ts';

// Note(yoochan.kim): the test client Socket stays UNTYPED (no protocol event
// maps) on purpose — rejection tests must be able to emit invalid payloads
// (e.g. changeVolume('loud')), which a protocol-typed emit would reject at
// compile time. The server side is fully protocol-typed instead.

// Note(yoochan.kim): Explicit test environment. These are declared test parameters — not hidden
// fallbacks — and may be overridden via env when targeting an externally
// running server.
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
// Note(yoochan.kim): Track library manifest (repo asset; tests only list tracks, never play them).
const TEST_TRACKS_MANIFEST_PATH = process.env.TRACKS_MANIFEST_PATH ?? './assets/tracks.json';
// Note(yoochan.kim): Who clients are told to call. Required like everything else, so it has to be
// declared here too — the bootstrap lists the environment rather than reading
// .env, which is what keeps a developer's own config out of the test run.
const TEST_ADMIN_CONTACT_NAME = process.env.ADMIN_CONTACT_NAME ?? '테스트 담당자';
const TEST_ADMIN_CONTACT_PHONE = process.env.ADMIN_CONTACT_PHONE ?? '010-0000-0000';

const DEFAULT_TEST_URL = `http://localhost:${TEST_PORT}`;

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

/**
 * Makes `npm test` self-contained: when nothing is listening on the test
 * port, starts an in-process MOCK-console server (real mpv stays paused, so
 * it is silent). An externally running dev server is used as-is.
 * Call from a top-level before() hook; pair with stopServer() in after().
 */
export async function ensureServer(): Promise<void> {
  if (await isPortOpen(TEST_PORT)) return;

  // Note(yoochan.kim): The server requires every env variable explicitly (fail-fast, no
  // defaults), so the test bootstrap supplies its declared test environment
  // before the server module graph is loaded.
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
  process.env.ADMIN_CONTACT_NAME = TEST_ADMIN_CONTACT_NAME;
  process.env.ADMIN_CONTACT_PHONE = TEST_ADMIN_CONTACT_PHONE;
  // Note(yoochan.kim): Start from a clean slate so boot uses INITIAL defaults, not a prior run.
  fs.rmSync(TEST_STATE_FILE_PATH, { force: true });

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

/** Stops the server only if ensureServer() started it in-process. */
export async function stopServer(): Promise<void> {
  if (startedServer) {
    startedServer.stop();
    startedServer = null;
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

  // Note(yoochan.kim): T has no default on purpose — every call site must
  // state the expected payload type explicitly (no silent `unknown`).
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

  // Note(yoochan.kim): Wait for an event (e.g. a broadcast) without emitting anything.
  waitFor<T>(responseEvent: string, ms = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No ${responseEvent}`)), ms);
      this.socket!.once(responseEvent, (data: T) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  // Note(yoochan.kim): Collect every payload of an event for `ms`, then resolve the array
  // (used to assert an ordered sequence of broadcasts, e.g. lock true/false).
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

  // Note(yoochan.kim): Emit an event and resolve true if responseEvent does NOT arrive within ms
  // (used to assert that an operation was blocked).
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

  /**
   * Connects and completes the handshake. A client must say hello before the
   * server accepts writes or invokes, so nearly every test starts here.
   * Returns the ready payload and the full state that follows it.
   */
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

  /**
   * Waits for the first state patch that satisfies `matches`. State is one
   * event carrying only what changed, so tests say which change they mean
   * rather than which event they expect.
   */
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

  /** Collects every state patch for `ms`, for asserting an ordered sequence. */
  collectStates(ms: number): Promise<StatePatch[]> {
    return this.collectFor<StatePatch>(S2C.STATE, ms);
  }

  /** Waits for a refusal of `target`, resolving its reason. */
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

  /** True when no state patch satisfying `matches` arrives within `ms`. */
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
