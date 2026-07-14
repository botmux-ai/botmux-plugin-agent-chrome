'use strict';

const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const WebSocket = require('ws');

const root = resolve(__dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'agent-chrome-broker-binding-'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const { port } = server.address();
  await new Promise(resolvePromise => server.close(resolvePromise));
  return port;
}

async function waitFor(url, timeoutMs = 5_000) {
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
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function expectWebSocketRejected(url) {
  return new Promise(resolvePromise => {
    const ws = new WebSocket(url);
    let opened = false;
    let settled = false;
    const finish = rejected => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolvePromise(rejected);
    };
    const timer = setTimeout(() => finish(!opened), 1_000);
    ws.once('open', () => { opened = true; finish(false); });
    ws.once('error', () => finish(true));
    ws.once('close', () => finish(!opened));
  });
}

async function main() {
  const chromePort = await freePort();
  const brokerPort = await freePort();
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
  await new Promise((resolvePromise, reject) => {
    chromeServer.once('error', reject);
    chromeServer.listen(chromePort, '127.0.0.1', resolvePromise);
  });

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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  broker.stderr.setEncoding('utf8');
  broker.stderr.on('data', chunk => { stderr += chunk; });

  const base = `http://127.0.0.1:${brokerPort}`;
  try {
    await waitFor(`${base}/health`);

    const bind = async (transport, sessionId) => fetch(`${base}/s/${transport}/bind`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });

    const first = await bind('transport-a', 'botmux-session-a');
    assert(first.ok, `first binding failed: ${await first.text()}`);
    const firstManifest = await (await fetch(`${base}/s/transport-a/manifest`)).json();
    assert(firstManifest.token === 'transport-a', 'manifest must expose the random access token, not the session id');
    assert(firstManifest.botmuxSessionId === 'botmux-session-a', 'manifest must expose the stable Botmux session id');
    const directIdentityLookup = await fetch(`${base}/s/botmux-session-a/manifest`);
    assert(directIdentityLookup.status === 404, 'session identity must not be accepted as an access token');
    assert(await expectWebSocketRejected(`ws://127.0.0.1:${brokerPort}/s/botmux-session-a/devtools/browser/direct`),
      'session identity must not authorize a CDP WebSocket');

    const reconnect = await bind('transport-b', 'botmux-session-a');
    assert(reconnect.ok, `reconnect binding failed: ${await reconnect.text()}`);
    const secondManifest = await (await fetch(`${base}/s/transport-b/manifest`)).json();
    assert(secondManifest.token === 'transport-a', 'reconnect must preserve the original random access token');
    const sessions = await (await fetch(`${base}/sessions`)).json();
    assert(sessions.length === 1, `reconnect created duplicate sessions: ${sessions.length}`);

    const rebound = await bind('transport-a', 'botmux-session-b');
    assert(rebound.status === 400, 'one transport must not rebind to a different session');
    const invalid = await bind('transport-invalid', '../escape');
    assert(invalid.status === 400, 'invalid session id must be rejected');

    await new Promise(resolvePromise => setTimeout(resolvePromise, 400));
    const expired = await fetch(`${base}/s/transport-a/manifest`);
    assert(expired.status === 404, 'unconnected binding must expire after the reconnect grace period');
    console.log('agent-chrome broker session binding test passed');
  } catch (error) {
    throw new Error(`${error.message}; broker stderr=${stderr}`);
  } finally {
    await stopProcess(broker);
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
