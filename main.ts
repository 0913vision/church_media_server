import 'dotenv/config';
import MediaServer from './server/server.js';

const server = new MediaServer();
server.start();

// Graceful shutdown on Ctrl-C / service stop
const shutdown = () => {
  server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
