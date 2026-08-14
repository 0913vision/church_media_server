// PM2 process definition. Build first, then start:
//   npm run build
//   pm2 start ecosystem.config.cjs
//   pm2 save      # remember the process list
//   pm2 startup   # run the printed command once, to auto-start on boot
//
// Changing the log paths below takes a delete and a fresh start — PM2 fixes
// them when the process is created, so a plain restart keeps the old ones.
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'church-media-server',
      script: 'dist/main.js',
      // Resolve .env, ./assets, and ./data from the project root.
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      // Named here rather than left to PM2, which otherwise appends the process
      // id — church-media-server-out-1.log — and that id changes whenever the
      // process is deleted and added back. The admin dashboard reads this file
      // by path, so a name that moves is a log that quietly disappears.
      out_file: path.join(__dirname, 'data', 'server.log'),
      error_file: path.join(__dirname, 'data', 'server.error.log'),
      // Without this PM2 suffixes the id even onto a name given here —
      // server-3.log — which is the whole problem being fixed.
      merge_logs: true,
      autorestart: true,
      min_uptime: '10s',
      max_restarts: 10,
      // Graceful-shutdown window for SIGINT (shutdown is instant; generous).
      kill_timeout: 5000
    }
  ]
};
