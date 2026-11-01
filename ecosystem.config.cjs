// Note(yoochan.kim): runs the built dist/, so npm run build first; pm2 save and pm2 startup bring it back on boot.
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'church-media-server',
      script: 'dist/main.js',
      // Note(yoochan.kim): .env, ./assets and ./data are relative paths.
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      // Note(yoochan.kim): fixed, as the admin dashboard reads the log by path; a change needs pm2 delete, not restart.
      out_file: path.join(__dirname, 'data', 'server.log'),
      error_file: path.join(__dirname, 'data', 'server.error.log'),
      // Note(yoochan.kim): without it PM2 still appends the process id, which changes, to the names above.
      merge_logs: true,
      autorestart: true,
      min_uptime: '10s',
      max_restarts: 10,
      // Note(yoochan.kim): shutdown is instant, so this is only a generous ceiling before SIGKILL.
      kill_timeout: 5000
    }
  ]
};
