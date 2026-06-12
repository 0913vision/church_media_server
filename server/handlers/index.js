import { registerAuthHandlers } from './authHandlers.js';
import { registerVolumeHandlers } from './volumeHandlers.js';
import { registerStateHandlers } from './stateHandlers.js';
import { registerSongHandlers } from './songHandlers.js';
import { registerMuteHandlers } from './muteHandlers.js';
import { registerConsoleHandlers } from './consoleHandlers.js';

/**
 * Registers every socket event handler for a connection.
 *
 * All handlers share one dependency context so the composition root (server.js)
 * wires the app in a single place and individual handlers destructure only
 * what they need.
 *
 * @param {Object} socket - Socket.IO socket instance
 * @param {Object} deps - Shared dependencies
 * @param {Notifier} deps.notifier - Single owner of all S2C emission
 * @param {Player} deps.player - Player instance
 * @param {LockCoordinator} deps.lockCoordinator - Lock coordinator instance
 * @param {AdminSessionManager} deps.adminSessionManager - Admin session manager
 * @param {MixerConsole} deps.mixerConsole - Shared mixing console service
 */
export const registerHandlers = (socket, deps) => {
  registerAuthHandlers(socket, deps);
  registerVolumeHandlers(socket, deps);
  registerStateHandlers(socket, deps);
  registerSongHandlers(socket, deps);
  registerMuteHandlers(socket, deps);
  registerConsoleHandlers(socket, deps);
};
