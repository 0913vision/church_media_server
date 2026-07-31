import type { ServerSocket } from '../constants/socketConfig.ts';
import { SOCKET_EVENTS } from '../constants/socketConfig.ts';
import { PlayerState } from '../constants/playerStates.ts';
import { log } from '../utils/logger.ts';
import { errorMessage } from '../utils/errors.ts';
import type { HandlerDeps } from './index.ts';

/**
 * Registers track-library socket event handlers (scheduled flows).
 */
export const registerTrackHandlers = (socket: ServerSocket, deps: HandlerDeps): void => {
  const { notifier, player, lockCoordinator, adminSessionManager, trackLibrary } = deps;

  /**
   * Handle track list request — always a single-recipient reply
   */
  socket.on(SOCKET_EVENTS.C2S_GET_TRACKS_EVENT, () => {
    try {
      notifier.tracksChanged(socket, trackLibrary.list());
    } catch (error) {
      log.error('trackHandler', socket, 'Error listing tracks', { error: errorMessage(error) });
    }
  });

  /**
   * Handle play-track-at request — audio resource operation. Starts a library
   * track from an offset (seconds), used by scheduled flows to join a
   * wall-clock-anchored timeline mid-song.
   */
  socket.on(SOCKET_EVENTS.C2S_PLAY_TRACK_AT_EVENT, async (trackId: unknown, offsetSec: unknown) => {
    try {
      if (typeof trackId !== 'string') {
        log.warn('trackHandler', socket, 'Invalid track id, request denied', { trackId });
        return;
      }
      const track = trackLibrary.get(trackId);
      if (!track) {
        log.warn('trackHandler', socket, 'Unknown track requested, request denied', { trackId });
        return;
      }
      if (typeof offsetSec !== 'number' || !Number.isFinite(offsetSec) || offsetSec < 0 || offsetSec >= track.durationSec) {
        log.warn('trackHandler', socket, 'Invalid track offset, request denied', { trackId, offsetSec });
        return;
      }

      const isAdmin = adminSessionManager.isAdminSocket(socket);
      const lockAcquired = await lockCoordinator.withAudioLock(isAdmin, async () => {
        await player.playTrackAt(track.file, offsetSec);
        notifier.trackChanged(track.id);
        notifier.stateChanged(PlayerState.PLAYING);
      });

      if (!lockAcquired) {
        log.warn('trackHandler', socket, 'Track playback blocked (admin lock or audio busy)', { trackId });
        return;
      }
    } catch (error) {
      log.error('trackHandler', socket, 'Error playing track', { error: errorMessage(error), trackId, offsetSec });
    }
  });

  /**
   * Handle restore-song request — returns the deck to the two-song system
   * (current song reloaded at its remembered position, paused). Sent by the
   * scheduled flow when it ends or is stopped.
   */
  socket.on(SOCKET_EVENTS.C2S_RESTORE_SONG_EVENT, async () => {
    try {
      const isAdmin = adminSessionManager.isAdminSocket(socket);
      const lockAcquired = await lockCoordinator.withAudioLock(isAdmin, async () => {
        await player.restoreSong();
        notifier.stateChanged(PlayerState.PAUSED);
      });

      if (!lockAcquired) {
        log.warn('trackHandler', socket, 'Song restore blocked (admin lock or audio busy)');
        return;
      }
    } catch (error) {
      log.error('trackHandler', socket, 'Error restoring song', { error: errorMessage(error) });
    }
  });
};
