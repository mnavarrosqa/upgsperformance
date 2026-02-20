/**
 * PM2 ecosystem file. Use: pm2 start ecosystem.config.cjs
 * Loads .env from the app directory automatically when PM2 runs the app.
 */
module.exports = {
  apps: [
    {
      name: 'upgs-perf',
      script: 'src/index.js',
      cwd: __dirname,
      interpreter: 'node',
      env: { NODE_ENV: 'production' },
      instances: 1,
      autorestart: true,
      watch: false,
    },
  ],
};
