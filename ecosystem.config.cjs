module.exports = {
  apps: [{
    name: 'search-api',
    script: 'src/app.js',
    instances: 'max',
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
    wait_ready: true,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 1000
  }]
};
