import 'dotenv/config';
import MediaServer from './server/server.ts';
import { log } from './server/utils/logger.ts';
import { errorMessage } from './server/utils/errors.ts';

const server = new MediaServer();
server.start();

// Note(yoochan.kim): pm2 stop and restart send SIGINT, then SIGKILL after kill_timeout; shutdown is instant.
const shutdown = (): void => {
  server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Note(yoochan.kim): exits non-zero so pm2 restarts it; mpv is in-process, so no audio is left playing.
const crash = (label: string, error: unknown): void => {
  log.error('main', null, label, { error: errorMessage(error) });
  try {
    server.stop();
  } catch {
    // Note(yoochan.kim): already shutting down.
  }
  process.exit(1);
};
process.on('uncaughtException', (error) => crash('Uncaught exception', error));
process.on('unhandledRejection', (reason) => crash('Unhandled promise rejection', reason));
