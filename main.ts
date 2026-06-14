import 'dotenv/config';
import MediaServer from './server/server.ts';
import { log } from './server/utils/logger.ts';
import { errorMessage } from './server/utils/errors.ts';

const server = new MediaServer();
server.start();

// Graceful shutdown on Ctrl-C / pm2 stop|restart (pm2 sends SIGINT, then
// SIGKILL after kill_timeout). Shutdown is instant, so it finishes in time.
const shutdown = (): void => {
  server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// On an unexpected error, log it and exit non-zero so pm2 restarts the process
// cleanly (the in-process mpv dies with it — no orphaned audio).
const crash = (label: string, error: unknown): void => {
  log.error('main', null, label, { error: errorMessage(error) });
  try {
    server.stop();
  } catch {
    // already shutting down — ignore
  }
  process.exit(1);
};
process.on('uncaughtException', (error) => crash('Uncaught exception', error));
process.on('unhandledRejection', (reason) => crash('Unhandled promise rejection', reason));
