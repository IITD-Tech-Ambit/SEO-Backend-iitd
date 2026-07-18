// webhook-verify: temporary comment to confirm Coolify auto-deploy fires for both search-api and embedding on push to prod
module.exports = {
  apps: [{
    name: 'search-api',
    script: 'src/app.js',
    instances: process.env.INSTANCES || 2,
    exec_mode: 'cluster',
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn'
    },
    error_file: '/dev/stderr',
    out_file: '/dev/stdout',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    listen_timeout: 10000,
    kill_timeout: 5000,
    // Requires process.send('ready') after fastify.listen — see src/app.js
    wait_ready: true,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 1000
  }]
};
