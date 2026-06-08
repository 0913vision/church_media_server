import { io } from 'socket.io-client';

const DEFAULT_TEST_URL = `http://localhost:${process.env.PORT || 4000}`;

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
