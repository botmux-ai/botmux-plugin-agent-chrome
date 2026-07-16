#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const root = path.resolve(__dirname, '..');
const env = {
  ...process.env,
  ACS_ROOT: process.env.ACS_ROOT || root,
};
const port = Number(env.ACS_BROKER_PORT || 9300);
const serviceInstanceId = crypto.randomUUID();
const brokerScript = path.join(root, 'bin', 'broker.js');
let broker = null;
let healthTimer = null;
let stopping = false;

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

function cleanPreviousBuilds() {
  const parent = path.dirname(root);
  for (const entry of fs.readdirSync(parent)) {
    if (entry.startsWith('.dist-previous-')) {
      fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
    }
  }
}

function health() {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 1000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          resolve(null);
          return;
        }
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

function portOpen() {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

async function waitForPortClosed(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await portOpen()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await health();
    if (state?.pid === broker?.pid && state?.serviceInstanceId === serviceInstanceId) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopBroker() {
  const child = broker;
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 5_000)) return;
  child.kill('SIGKILL');
  await waitForExit(child, 1_000);
}

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (healthTimer) clearInterval(healthTimer);
  try {
    await stopBroker();
    await run('acs-down.sh');
  } catch (err) {
    console.error(err?.message || err);
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });

(async () => {
  await run('acs-up.sh', ['--prepare-only']);

  if (await portOpen()) {
    console.log(`[broker] replacing existing listener on :${port}`);
    await run('acs-down.sh');
    if (!await waitForPortClosed()) throw new Error(`Agent Chrome broker port ${port} did not close`);
  }

  broker = spawn(process.execPath, [brokerScript], {
    cwd: root,
    env: {
      ...env,
      ACS_SERVICE_INSTANCE_ID: serviceInstanceId,
    },
    stdio: 'inherit',
  });
  broker.once('error', error => {
    if (!stopping) {
      console.error(`Agent Chrome broker failed to start: ${error.message}`);
      void shutdown(1);
    }
  });
  broker.once('exit', (code, signal) => {
    if (stopping) return;
    console.error(`Agent Chrome broker exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`})`);
    void shutdown(code && code > 0 ? code : 1);
  });

  if (!await waitForHealth()) {
    throw new Error(`Agent Chrome broker did not become healthy on ${port}`);
  }
  console.log(`[broker] managed child ready pid=${broker.pid} instance=${serviceInstanceId}`);
  cleanPreviousBuilds();
  healthTimer = setInterval(async () => {
    if (stopping) return;
    const state = await health();
    if (state?.pid !== broker?.pid || state?.serviceInstanceId !== serviceInstanceId) {
      console.error('Agent Chrome broker health check failed');
      await shutdown(1);
    }
  }, 5000).unref();
})().catch(error => {
  console.error(error?.stack || error?.message || error);
  void shutdown(1);
});
