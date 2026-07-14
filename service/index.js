const { mkdirSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const port = Number(process.env.ACS_BROKER_PORT || 9300);
const dataRoot = process.env.ACS_DATA_ROOT
  || process.env.AGENT_CHROME_HOME
  || join(homedir(), '.agent-chrome');
const runtimeDir = join(dataRoot, 'run');

mkdirSync(runtimeDir, { recursive: true });

module.exports = {
  mode: 'auto',
  port,
  pm2: {
    script: join(__dirname, 'runner.js'),
    cwd: runtimeDir,
    env: {
      ACS_BROKER_PORT: String(port),
      ACS_DATA_ROOT: dataRoot,
      ACS_RUN: runtimeDir,
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
