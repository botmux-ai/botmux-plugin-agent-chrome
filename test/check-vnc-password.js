'use strict';

// VNC 密码生命周期：
//  1. 首次启动随机生成密码，落盘 private/vnc-password.txt（0600），并生成 -rfbauth 用的混淆文件
//  2. 重启后密码保持不变（持久化）
//  3. ACS_VNC_PASSWORD 显式覆盖时以环境变量为准
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, existsSync, readFileSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const WebSocket = require('ws');

const root = resolve(__dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'agent-chrome-vnc-password-'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectError) => {
    server.once('error', rejectError);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const { port } = server.address();
  await new Promise(resolvePromise => server.close(resolvePromise));
  return port;
}

async function waitFor(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolvePromise => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

// 假 Chrome：/json/version + 一个接受任意 CDP 命令的 browser ws
async function startFakeChrome(chromePort) {
  const chromeServer = createServer((request, response) => {
    if (request.url === '/json/version') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        Browser: 'Fake Chrome',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: `ws://127.0.0.1:${chromePort}/devtools/browser/fake`,
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const chromeWs = new WebSocket.Server({ noServer: true });
  chromeServer.on('upgrade', (request, socket, head) => {
    if (request.url !== '/devtools/browser/fake') {
      socket.destroy();
      return;
    }
    chromeWs.handleUpgrade(request, socket, head, ws => chromeWs.emit('connection', ws));
  });
  chromeWs.on('connection', ws => {
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.id !== undefined) ws.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  await new Promise((resolvePromise, rejectError) => {
    chromeServer.once('error', rejectError);
    chromeServer.listen(chromePort, '127.0.0.1', resolvePromise);
  });
  return { chromeServer, chromeWs };
}

async function startBroker(chromePort, brokerPort, extraEnv = {}) {
  let stderr = '';
  const broker = spawn(process.execPath, [join(root, 'dist', 'bin', 'broker.js')], {
    cwd: root,
    env: {
      ...process.env,
      ACS_DATA_ROOT: temp,
      ACS_RUN: join(temp, 'run'),
      ACS_MANIFESTS: join(temp, 'run', 'manifests'),
      ACS_LOGS: join(temp, 'logs'),
      ACS_CHROME_PORT: String(chromePort),
      ACS_BROKER_PORT: String(brokerPort),
      ACS_RECONNECT_GRACE_MS: '250',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  broker.stderr.setEncoding('utf8');
  broker.stderr.on('data', chunk => { stderr += chunk; });
  await waitFor(`http://127.0.0.1:${brokerPort}/health`);
  return { broker, stderr: () => stderr };
}

async function main() {
  const chromePort = await freePort();
  const { chromeServer, chromeWs } = await startFakeChrome(chromePort);
  const plainFile = join(temp, 'private', 'vnc-password.txt');
  const hashFile = join(temp, 'private', 'vnc-passwd');

  try {
    // 1. 首次启动：随机密码落盘
    let brokerPort = await freePort();
    let started = await startBroker(chromePort, brokerPort);
    await stopProcess(started.broker);

    assert(existsSync(plainFile), 'vnc-password.txt must be created on first start');
    const password = readFileSync(plainFile, 'utf8').trim();
    assert(password.length >= 16, `random password must be strong (>=16 chars), got ${password.length}`);
    assert(/^[A-Za-z0-9_-]+$/.test(password), 'random password must be URL-safe (base64url)');
    const plainMode = statSync(plainFile).mode & 0o777;
    assert(plainMode === 0o600, `vnc-password.txt must be 0600, got 0o${plainMode.toString(8)}`);
    if (existsSync(hashFile)) {
      const hashMode = statSync(hashFile).mode & 0o777;
      assert(hashMode === 0o600, `vnc-passwd must be 0600 when present, got 0o${hashMode.toString(8)}`);
    }

    // 2. 重启：密码保持不变
    brokerPort = await freePort();
    started = await startBroker(chromePort, brokerPort);
    await stopProcess(started.broker);
    assert(readFileSync(plainFile, 'utf8').trim() === password, 'password must persist across restarts');

    // 3. ACS_VNC_PASSWORD 覆盖
    brokerPort = await freePort();
    started = await startBroker(chromePort, brokerPort, { ACS_VNC_PASSWORD: 'override-test-pass' });
    await stopProcess(started.broker);
    assert(readFileSync(plainFile, 'utf8').trim() === 'override-test-pass',
      'ACS_VNC_PASSWORD must take precedence');

    console.log('agent-chrome VNC password lifecycle test passed');
  } finally {
    for (const client of chromeWs.clients) client.close();
    await new Promise(resolvePromise => chromeServer.close(resolvePromise));
  }
}

main()
  .finally(() => rmSync(temp, { recursive: true, force: true }))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
