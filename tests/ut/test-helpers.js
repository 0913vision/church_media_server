import { io } from 'socket.io-client';
import net from 'node:net';

const TEST_PORT = Number(process.env.PORT || 4000);
const DEFAULT_TEST_URL = `http://localhost:${TEST_PORT}`;

let startedServer = null;

function isPortOpen(port) {
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
export async function ensureServer() {
  if (await isPortOpen(TEST_PORT)) return;

  process.env.CONSOLE_MODE = process.env.CONSOLE_MODE || 'MOCK';
  process.env.PORT = process.env.PORT || String(TEST_PORT);

  const { default: MediaServer } = await import('../../server/server.js');
  startedServer = new MediaServer();
  startedServer.start();

  for (let i = 0; i < 50; i++) {
    if (await isPortOpen(TEST_PORT)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Test server failed to start on port ${TEST_PORT}`);
}

/** Stops the server only if ensureServer() started it in-process. */
export async function stopServer() {
  if (startedServer) {
    startedServer.stop();
    startedServer = null;
  }
}

export class SocketTestHelper {
  constructor(url = DEFAULT_TEST_URL, options = {}) {
    this.url = url;
    this.options = options;
    this.socket = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = io(this.url, this.options);
      const timer = setTimeout(() => reject(new Error('Connection timeout')), 10000);

      this.socket.on('connect', () => {
        clearTimeout(timer);
        resolve(this.socket);
      });
      this.socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  emitAndWaitFor(event, responseEvent, ...args) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No response for ${event}`)), 5000);
      this.socket.once(responseEvent, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      this.socket.emit(event, ...args);
    });
  }

  // Wait for an event (e.g. a broadcast) without emitting anything.
  waitFor(responseEvent, ms = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No ${responseEvent}`)), ms);
      this.socket.once(responseEvent, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  // Collect every payload of an event for `ms`, then resolve the array
  // (used to assert an ordered sequence of broadcasts, e.g. lock true/false).
  collectFor(event, ms) {
    return new Promise((resolve) => {
      const received = [];
      const onEvent = (data) => received.push(data);
      this.socket.on(event, onEvent);
      setTimeout(() => {
        this.socket.off(event, onEvent);
        resolve(received);
      }, ms);
    });
  }

  // Emit an event and resolve true if responseEvent does NOT arrive within ms
  // (used to assert that an operation was blocked).
  emitAndExpectNoResponse(event, responseEvent, ms, ...args) {
    return new Promise((resolve) => {
      let received = false;
      const onResponse = () => { received = true; };
      this.socket.on(responseEvent, onResponse);
      this.socket.emit(event, ...args);
      setTimeout(() => {
        this.socket.off(responseEvent, onResponse);
        resolve(!received);
      }, ms);
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
}
