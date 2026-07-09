#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const env = {
  ...process.env,
  ACS_ROOT: process.env.ACS_ROOT || root,
};
const port = Number(env.ACS_BROKER_PORT || 9300);

function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [path.join(root, 'bin', script), ...args], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with ${code}`));
    });
  });
}

function health() {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 1000 }, res => {
      res.resume();
      resolve(res.statusCode && res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitForHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await health()) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await run('acs-down.sh', ['--all']);
  } catch (err) {
    console.error(err?.message || err);
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  await run('acs-up.sh');
  if (!await waitForHealth()) {
    throw new Error(`Agent Chrome broker did not become healthy on ${port}`);
  }
  setInterval(async () => {
    if (stopping) return;
    if (!await health()) {
      console.error('Agent Chrome broker health check failed');
      process.exit(1);
    }
  }, 5000).unref();
})();

