import type Notifier from './notify/Notifier.ts';
import type Player from './player/Player.ts';
import type LockCoordinator from './lock/LockCoordinator.ts';
import type AdminSessionManager from './auth/AdminSessionManager.ts';
import type MixerConsole from './console/MixerConsole.ts';
import type TrackLibrary from './tracks/TrackLibrary.ts';
import type Uploads from './tracks/Uploads.ts';
import type Fetcher from './tracks/Fetcher.ts';
import type FlowRunner from './flow/FlowRunner.ts';
import type Schedule from './schedule/Schedule.ts';
import type AutoStarter from './schedule/AutoStarter.ts';
import type AdminSession from './lock/AdminSession.ts';
import type Clock from './clock/Clock.ts';
import type LevelMatcher from './level/LevelMatcher.ts';

/** Own module, so the attribute and command tables use it without importing the handlers that register them. */
export interface ServerDeps {
  /** Single owner of all S2C emission */
  notifier: Notifier;
  player: Player;
  lockCoordinator: LockCoordinator;
  adminSessionManager: AdminSessionManager;
  mixerConsole: MixerConsole;
  trackLibrary: TrackLibrary;
  /** Audio sent to POST /uploads, waiting for addTrack */
  uploads: Uploads;
  /** Fetches a YouTube video's audio for addTrack, one at a time */
  fetcher: Fetcher;
  /** Runs the one flow this server may have in flight */
  flowRunner: FlowRunner;
  /** The weekly calendar: which flows exist and when they may run */
  schedule: Schedule;
  autoStarter: AutoStarter;
  /** Everything about a gate a person holds that runs on a clock */
  adminSession: AdminSession;
  /** Church time — every instant on the wire is read against it */
  clock: Clock;
  /** Measures a track on the desk and moves its level onto a target */
  levelMatcher: LevelMatcher;
}
