import { io } from 'socket.io-client';

export class SocketTestHelper {
  constructor(url = 'http://localhost:3000', options = {}) {
    this.url = url;
    this.options = options;
    this.socket = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = io(this.url, this.options);
      
      this.socket.on('connect', () => resolve(this.socket));
      this.socket.on('connect_error', (err) => reject(err));
      
      setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);
    });
  }

  emitAndWaitFor(event, responseEvent, ...args) {
    return new Promise((resolve, reject) => {
      this.socket.emit(event, ...args);
      
      this.socket.on(responseEvent, (data) => resolve(data));
      
      setTimeout(() => {
        reject(new Error(`No response for ${event}`));
      }, 5000);
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
}