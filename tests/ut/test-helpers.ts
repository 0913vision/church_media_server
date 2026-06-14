import { io } from 'socket.io-client';
import type { Socket, ManagerOptions, SocketOptions } from 'socket.io-client';
import net from 'node:net';

// Note(yoochan.kim): the test client Socket stays UNTYPED (no protocol event
// maps) on purpose — rejection tests must be able to emit invalid payloads
// (e.g. changeVolume('loud')), which a protocol-typed emit would reject at
// compile time. The server side is fully protocol-typed instead.

// Explicit test environment. These are declared test parameters — not hidden
// fallbacks — and may be overridden via env when targeting an externally
// running server.
export const TEST_PORT = Number(process.env.PORT ?? '4000');
export const TEST_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin123';
const TEST_CONSOLE_MODE = process.env.CONSOLE_MODE ?? 'MOCK';
const TEST_LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
// X32 config is required at module load even in MOCK mode; supply test values.
const TEST_X32_REMOTE_ADDRESS = process.env.X32_REMOTE_ADDRESS ?? '127.0.0.1';
const TEST_X32_REMOTE_PORT = process.env.X32_REMOTE_PORT ?? '10023';
// libmpv path is required at module load (real mpv boots even in MOCK mode).
const TEST_MPV_LIBRARY_PATH = process.env.MPV_LIBRARY_PATH ?? '/opt/homebrew/lib/libmpv.dylib';

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

  // The server requires every env variable explicitly (fail-fast, no
  // defaults), so the test bootstrap supplies its declared test environment
  // before the server module graph is loaded.
  process.env.PORT = String(TEST_PORT);
  process.env.CONSOLE_MODE = TEST_CONSOLE_MODE;
  process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
  process.env.LOG_LEVEL = TEST_LOG_LEVEL;
  process.env.X32_REMOTE_ADDRESS = TEST_X32_REMOTE_ADDRESS;
  process.env.X32_REMOTE_PORT = TEST_X32_REMOTE_PORT;
  process.env.MPV_LIBRARY_PATH = TEST_MPV_LIBRARY_PATH;

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

  // Wait for an event (e.g. a broadcast) without emitting anything.
  waitFor<T>(responseEvent: string, ms = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No ${responseEvent}`)), ms);
      this.socket!.once(responseEvent, (data: T) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  // Collect every payload of an event for `ms`, then resolve the array
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

  // Emit an event and resolve true if responseEvent does NOT arrive within ms
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

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
}
