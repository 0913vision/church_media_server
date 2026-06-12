import { Server } from 'socket.io';
import { SOCKET_CONFIG, SOCKET_EVENTS } from './constants/socketConfig.js';
import Player from './player/Player.js';
import LockCoordinator from './lock/LockCoordinator.js';
import AdminSessionManager from './auth/AdminSessionManager.js';
import ConsoleHandler from './console/ConsoleHandler.js';
import { registerHandlers } from './handlers/index.js';
import { log } from './utils/logger.js';

/**
 * Composition root: builds the shared singletons, wires them into a dependency
 * context, and attaches handler registration to incoming connections.
 */
class MediaServer {
  start() {
    log.info('server', null, 'Socket is initializing');

    const io = new Server(SOCKET_CONFIG.PORT, {
      cors: SOCKET_CONFIG.CORS,
    });

    // Shared singletons (created once, reused across all connections)
    const player = new Player();
    const adminSessionManager = new AdminSessionManager();
    const lockCoordinator = new LockCoordinator(io, adminSessionManager);
    const consoleHandler = new ConsoleHandler();

    const deps = { io, player, lockCoordinator, adminSessionManager, consoleHandler };

    setInterval(() => {
      io.emit(SOCKET_EVENTS.S2C_PING_EVENT);
    }, SOCKET_CONFIG.PING_INTERVAL_MS);

    io.on('connection', (socket) => {
      log.info('server', socket, 'Socket connected', { ip: socket.handshake.address });

      registerHandlers(socket, deps);

      socket.on('disconnect', (reason) => {
        lockCoordinator.handleDisconnect(socket);
        log.info('server', socket, 'Socket disconnected', { reason });
      });
    });
  }
}

export default MediaServer;
