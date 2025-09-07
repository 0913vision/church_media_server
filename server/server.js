import { Server } from 'socket.io';
import { SOCKET_CONFIG } from './constants/socketConfig.js';
import Player from './player/Player.js';
import NetworkLockManager from './lock/NetworkLockManager.js';
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

  // Create single Player instance and NetworkLockManager
  const player = new Player();
  const lockManager = new NetworkLockManager(io);

  const pingInterval = setInterval(() => {
    io.emit('ping');
  }, SOCKET_CONFIG.PING_INTERVAL_MS);

  io.on('connection', (socket) => {
    // Register all handlers with Player and NetworkLockManager instances
    registerVolumeHandlers(socket, io, player);
    registerStateHandlers(socket, io, player, lockManager);
    registerSongHandlers(socket, io, player, lockManager);
    registerMuteHandlers(socket, io, player);
    registerConsoleHandlers(socket, io, player);
  });
  }
}

export default MediaServer