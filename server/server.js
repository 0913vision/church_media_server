import { Server } from 'socket.io';
import { SOCKET_CONFIG, SOCKET_EVENTS } from './constants/socketConfig.js';
import Player from './player/Player.js';
import LockCoordinator from './lock/LockCoordinator.js';
import AdminSessionManager from './auth/AdminSessionManager.js';
import ConsoleHandler from './console/ConsoleHandler.js';
import { registerAuthHandlers } from './handlers/authHandlers.js';
import { registerVolumeHandlers } from './handlers/volumeHandlers.js';
import { registerStateHandlers } from './handlers/stateHandlers.js';
import { registerSongHandlers } from './handlers/songHandlers.js';
import { registerMuteHandlers } from './handlers/muteHandlers.js';
import { registerConsoleHandlers } from './handlers/consoleHandlers.js';
import { log } from './utils/logger.js';

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

    setInterval(() => {
      io.emit(SOCKET_EVENTS.S2C_PING_EVENT);
    }, SOCKET_CONFIG.PING_INTERVAL_MS);

    io.on('connection', (socket) => {
      log.info('server', socket, 'Socket connected', { ip: socket.handshake.address });

      // Register all handlers
      registerAuthHandlers(socket, adminSessionManager, lockCoordinator);
      registerVolumeHandlers(socket, io, player, lockCoordinator);
      registerStateHandlers(socket, io, player, lockCoordinator);
      registerSongHandlers(socket, io, player, lockCoordinator);
      registerMuteHandlers(socket, io, player, lockCoordinator);
      registerConsoleHandlers(socket, lockCoordinator, consoleHandler);

      socket.on('disconnect', (reason) => {
        lockCoordinator.handleDisconnect(socket);
        log.info('server', socket, 'Socket disconnected', { reason });
      });
    });
  }
}

export default MediaServer;
