import { Server } from 'socket.io';
import { SOCKET_CONFIG } from './constants/socketConfig.js';
import Player from './player/Player.js';
import LockCoordinator from './lock/LockCoordinator.js';
import AdminSessionManager from './auth/AdminSessionManager.js';
import MixerConsole from './console/MixerConsole.js';
import Notifier from './notify/Notifier.js';
import { registerHandlers } from './handlers/index.js';
import { log } from './utils/logger.js';

/**
 * Composition root: builds the shared singletons, wires them into a dependency
 * context, and attaches handler registration to incoming connections.
 */
class MediaServer {
  #io = null;
  #pingInterval = null;

  start() {
    log.info('server', null, 'Socket is initializing');

    const io = new Server(SOCKET_CONFIG.PORT, {
      cors: SOCKET_CONFIG.CORS,
    });
    this.#io = io;

    // Shared singletons (created once, reused across all connections).
    // Only the Notifier touches io directly; everything else speaks domain.
    const notifier = new Notifier(io);
    const player = new Player();
    const adminSessionManager = new AdminSessionManager();
    const lockCoordinator = new LockCoordinator(notifier);
    const mixerConsole = new MixerConsole();

    const deps = { notifier, player, lockCoordinator, adminSessionManager, mixerConsole };

    this.#pingInterval = setInterval(() => {
      notifier.ping();
    }, SOCKET_CONFIG.PING_INTERVAL_MS);

    io.on('connection', (socket) => {
      log.info('server', socket, 'Socket connected', { ip: socket.handshake.address });

      registerHandlers(socket, deps);

      socket.on('disconnect', (reason) => {
        lockCoordinator.handleDisconnect(socket.id);
        log.info('server', socket, 'Socket disconnected', { reason });
      });
    });
  }

  /**
   * Graceful shutdown: stop the heartbeat and close all socket connections.
   * The MPV instance is released when the process exits.
   */
  stop() {
    log.info('server', null, 'Shutting down');

    if (this.#pingInterval) {
      clearInterval(this.#pingInterval);
      this.#pingInterval = null;
    }
    if (this.#io) {
      this.#io.close();
      this.#io = null;
    }
  }
}

export default MediaServer;
