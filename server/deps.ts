import type Notifier from './notify/Notifier.ts';
import type Player from './player/Player.ts';
import type LockCoordinator from './lock/LockCoordinator.ts';
import type AdminSessionManager from './auth/AdminSessionManager.ts';
import type MixerConsole from './console/MixerConsole.ts';
import type TrackLibrary from './tracks/TrackLibrary.ts';
import type FlowRunner from './flow/FlowRunner.ts';
import type Clock from './clock/Clock.ts';

/**
 * Shared dependency context built once by the composition root (server.ts) and
 * handed to the device tables and the socket handlers; each destructures only
 * what it needs. Kept in its own module so the attribute and command tables can
 * use it without importing the handlers that register them.
 */
export interface ServerDeps {
  /** Single owner of all S2C emission */
  notifier: Notifier;
  player: Player;
  lockCoordinator: LockCoordinator;
  adminSessionManager: AdminSessionManager;
  /** Shared mixing console service */
  mixerConsole: MixerConsole;
  /** Library of playable tracks for scheduled flows */
  trackLibrary: TrackLibrary;
  /** Runs the one flow this server may have in flight */
  flowRunner: FlowRunner;
  /** Church time — every instant on the wire is read against it */
  clock: Clock;
}
