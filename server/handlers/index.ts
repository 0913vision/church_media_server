import type { ServerSocket } from '../constants/socketConfig.ts';
import type Notifier from '../notify/Notifier.ts';
import type Player from '../player/Player.ts';
import type LockCoordinator from '../lock/LockCoordinator.ts';
import type AdminSessionManager from '../auth/AdminSessionManager.ts';
import type MixerConsole from '../console/MixerConsole.ts';
import type TrackLibrary from '../tracks/TrackLibrary.ts';
import { registerAuthHandlers } from './authHandlers.ts';
import { registerVolumeHandlers } from './volumeHandlers.ts';
import { registerStateHandlers } from './stateHandlers.ts';
import { registerSongHandlers } from './songHandlers.ts';
import { registerMuteHandlers } from './muteHandlers.ts';
import { registerConsoleHandlers } from './consoleHandlers.ts';
import { registerTrackHandlers } from './trackHandlers.ts';

/**
 * Shared dependency context built once by the composition root (server.js)
 * and handed to every handler; each handler destructures only what it needs.
 */
export interface HandlerDeps {
  /** Single owner of all S2C emission */
  notifier: Notifier;
  player: Player;
  lockCoordinator: LockCoordinator;
  adminSessionManager: AdminSessionManager;
  /** Shared mixing console service */
  mixerConsole: MixerConsole;
  /** Library of playable tracks for scheduled flows */
  trackLibrary: TrackLibrary;
}

/**
 * Registers every socket event handler for a connection.
 */
export const registerHandlers = (socket: ServerSocket, deps: HandlerDeps): void => {
  registerAuthHandlers(socket, deps);
  registerVolumeHandlers(socket, deps);
  registerStateHandlers(socket, deps);
  registerSongHandlers(socket, deps);
  registerMuteHandlers(socket, deps);
  registerConsoleHandlers(socket, deps);
  registerTrackHandlers(socket, deps);
};
