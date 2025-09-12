import { Server } from 'socket.io';
import { SOCKET_CONFIG } from './constants/socketConfig.js';
import Player from './player/Player.js';
import LockCoordinator from './lock/LockCoordinator.js';
import AdminSessionManager from './auth/AdminSessionManager.js';
import { registerAuthHandlers } from './handlers/authHandlers.js';
import { registerVolumeHandlers } from './handlers/volumeHandlers.js';
import { registerStateHandlers } from './handlers/stateHandlers.js';
import { registerSongHandlers } from './handlers/songHandlers.js';
import { registerMuteHandlers } from './handlers/muteHandlers.js';
import { registerConsoleHandlers } from './handlers/consoleHandlers.js';

class MediaServer {
  start() {
  console.log('Socket is initializing')
  
  const io = new Server(SOCKET_CONFIG.PORT, {
    cors: SOCKET_CONFIG.CORS,
  })
  global.io = io

  // Create single Player instance and managers
  const player = new Player();
  const lockCoordinator = new LockCoordinator(io);
  const adminSessionManager = new AdminSessionManager();

  const pingInterval = setInterval(() => {
    io.emit('ping');
  }, SOCKET_CONFIG.PING_INTERVAL_MS);

  io.on('connection', (socket) => {
    // Register all handlers
    registerAuthHandlers(socket, adminSessionManager);
    registerVolumeHandlers(socket, io, player, lockCoordinator);
    registerStateHandlers(socket, io, player, lockCoordinator);
    registerSongHandlers(socket, io, player, lockCoordinator);
    registerMuteHandlers(socket, io, player, lockCoordinator);
    registerConsoleHandlers(socket, lockCoordinator);
  });
  }
}

export default MediaServer