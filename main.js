// Set platform environment variable
process.env.PLATFORM = process.platform === 'darwin' ? 'MAC' : 'RASPBERRY_PI';

import MediaServer from './server/server.js';

const server = new MediaServer();
server.start();