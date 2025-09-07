import 'dotenv/config';
import MediaServer from './server/server.js';

const server = new MediaServer();
server.start();