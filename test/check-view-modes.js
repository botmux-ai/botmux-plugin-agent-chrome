'use strict';

// Session dashboard state machine: Follow tracks Agent activity; Free keeps one
// stable noVNC endpoint while switching Page targets and falls back on close.
const WebSocket = require('ws');
const { CDP, httpGetJson } = require('../lib/cdp');

const BROKER = `http://127.0.0.1:${process.env.ACS_BROKER_PORT || 9300}`;
const PORT = process.env.ACS_BROKER_PORT || 9300;
const TOKEN = `views${Date.now()}`;
const BOTMUX_SESSION_ID = `botmux-e2e-${Date.now()}`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect() {
  const ws = new WebSocket(
    `ws://127.0.0.1:${PORT}/s/${TOKEN}/devtools/browser/test?botmuxSessionId=${encodeURIComponent(BOTMUX_SESSION_ID)}`,
    { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 },
  );
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return new CDP(ws);
}

async function put(path, body) {
  const response = await fetch(`${BROKER}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitFor(predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const manifest = await httpGetJson(`${BROKER}/s/${TOKEN}/manifest`);
      if (predicate(manifest)) return manifest;
    } catch {}
    await sleep(100);
  }
  throw new Error('timed out waiting for session manifest state');
}

(async () => {
  const cdp = await connect();
  try {
    const first = await cdp.send('Target.createTarget', {
      url: 'data:text/html,<title>First page</title>',
      newWindow: true,
      width: 1728,
      height: 1117,
    });
    const second = await cdp.send('Target.createTarget', {
      url: 'data:text/html,<title>Second page</title>',
      newWindow: true,
      width: 1728,
      height: 1117,
    });
    let manifest = await waitFor(value => value.pages?.length === 2 && value.follow?.novncUrl);
    const metadataLinked = manifest.botmuxSessionId === BOTMUX_SESSION_ID;
    const followUrl = manifest.follow.novncUrl;
    const followPort = manifest.follow.novncPort;

    await cdp.send('Target.activateTarget', { targetId: first.targetId });
    manifest = await waitFor(value => value.follow?.targetId === first.targetId);
    const followReused = manifest.follow.novncUrl === followUrl && manifest.follow.novncPort === followPort;

    await put(`/s/${TOKEN}/view-mode`, { mode: 'free' });
    manifest = await waitFor(value => value.mode === 'free' && value.free?.novncUrl);
    const freeStarted = manifest.mode === 'free' && Boolean(manifest.free?.novncUrl);
    const freeUrl = manifest.free.novncUrl;
    const freePort = manifest.free.novncPort;

    manifest = await put(`/s/${TOKEN}/free-target`, { targetId: second.targetId });
    await waitFor(value => value.free?.targetId === second.targetId && value.free?.status === 'connected');
    const freeReused = manifest.free.novncUrl === freeUrl && manifest.free.novncPort === freePort;

    await cdp.send('Target.closeTarget', { targetId: second.targetId });
    manifest = await waitFor(value => value.pages?.length === 1 && value.free?.targetId === first.targetId);
    const closeFallback = manifest.mode === 'free'
      && manifest.free.novncUrl === freeUrl
      && manifest.free.novncPort === freePort;

    manifest = await put(`/s/${TOKEN}/view-mode`, { mode: 'follow' });
    const freeReclaimed = manifest.mode === 'follow'
      && manifest.free?.enabled === false
      && !manifest.free?.novncUrl;

    const pass = metadataLinked && followReused && freeStarted && freeReused && closeFallback && freeReclaimed;
    console.log(JSON.stringify({
      metadataLinked,
      followReused,
      freeStarted,
      freeReused,
      closeFallback,
      freeReclaimed,
    }, null, 2));
    console.log(pass ? 'PASS: Session Follow/Free VNC 状态机正常' : 'FAIL');
    process.exitCode = pass ? 0 : 1;
  } finally {
    cdp.close();
    await sleep(600);
  }
})().catch(error => {
  console.error('ERR', error);
  process.exit(1);
});
