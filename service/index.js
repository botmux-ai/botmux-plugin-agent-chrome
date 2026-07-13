const port = Number(process.env.ACS_BROKER_PORT || 9300);

module.exports = {
  mode: 'manual',
  port,
  pm2: {
    script: './service/runner.js',
    env: {
      ACS_BROKER_PORT: String(port),
    },
    autorestart: true,
  },
  urls({ host }) {
    return {
      openUrl: `http://${host}:${port}/`,
      healthUrl: `http://${host}:${port}/health`,
    };
  },
};
