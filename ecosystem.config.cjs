// PM2 process definition. Build first, then start:
//   npm run build
//   pm2 start ecosystem.config.cjs
//   pm2 save      # remember the process list
//   pm2 startup   # run the printed command once, to auto-start on boot
module.exports = {
  apps: [
    {
      name: 'church-media-server',
      script: 'dist/main.js',
      // Resolve .env, ./assets, and ./data from the project root.
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      min_uptime: '10s',
      max_restarts: 10,
      // Graceful-shutdown window for SIGINT (shutdown is instant; generous).
      kill_timeout: 5000
    }
  ]
};
