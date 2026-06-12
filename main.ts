import 'dotenv/config';
import MediaServer from './server/server.ts';

const server = new MediaServer();
server.start();

// Graceful shutdown on Ctrl-C / service stop
const shutdown = (): void => {
  server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
