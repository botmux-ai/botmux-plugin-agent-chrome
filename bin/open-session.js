'use strict';
/*
 * 在 ACS 基座上开一个会话、打开指定 URL，并【保活】（持续连接，会话不被 teardown），
 * 以便用户通过 noVNC 实时观看 / 操作。
 *
 *   node bin/open-session.js "<url>" [token] [--writable]
 *
 * 启动后把结果（token / noVNC URL / windowId / 截图路径）写到 run/<token>.json，
 * 截图写到 run/<token>.png，然后挂住进程直到被 kill。
 * 建议用 setsid/nohup 后台跑，使其独立于调用方存活。
 */
const { CDP, httpGetJson, waitManifest } = require('../lib/cdp');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BROKER = 'http://127.0.0.1:9300';
const RUN = path.join(__dirname, '..', 'run');
const url = process.argv[2];
const token = process.argv[3] || ('member-' + Date.now());
const writable = process.argv.includes('--writable');
if (!url) { console.error('usage: open-session.js <url> [token] [--writable]'); process.exit(2); }

let cdp;
async function main() {
  const ws = `ws://127.0.0.1:9300/s/${token}/devtools/browser/x${Math.random().toString(16).slice(2)}`;
  cdp = new (require('ws'))(ws, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  await new Promise((res, rej) => { cdp.once('open', res); cdp.once('error', rej); });
  const client = new CDP(cdp);

  await client.send('Target.setDiscoverTargets', { discover: true });
  const { targetId } = await client.send('Target.createTarget', { url });

  const mf = await waitManifest(BROKER, token, 15000);
  if (!mf) { console.error('provisioning timeout'); process.exit(1); }

  if (writable) { try { await httpGetJson(`${BROKER}/s/${token}/viewonly?on=0`); } catch {} }

  // 等页面加载/跳转 settle，再截图
  await new Promise((r) => setTimeout(r, 6000));
  const shot = path.join(RUN, `${token}.png`);
  try { execSync(`DISPLAY=:77 import -window ${mf.primaryWindowId} ${shot}`); } catch (e) { console.error('shot err', e.message); }

  // 读取当前实际 URL/标题
  let pageInfo = {};
  try {
    const r = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const ev = await client.send('Runtime.evaluate', { expression: 'JSON.stringify({url:location.href,title:document.title})', returnByValue: true }, r.sessionId);
    pageInfo = JSON.parse(ev.result.value);
  } catch {}

  const out = {
    token, targetId,
    requestedUrl: url,
    landedUrl: pageInfo.url || null,
    title: pageInfo.title || null,
    windowId: mf.primaryWindowId,
    novncUrl: (writable ? mf.novncUrl : mf.novncUrl),
    viewonly: writable ? false : mf.viewonly,
    screenshot: shot,
    ready: true,
  };
  fs.writeFileSync(path.join(RUN, `${token}.json`), JSON.stringify(out, null, 2));
  console.log('READY ' + JSON.stringify(out));

  // 保活：持续持有连接，会话不 teardown
  setInterval(() => {}, 1 << 30);
}
process.on('SIGTERM', () => { try { cdp && cdp.close(); } catch {}; process.exit(0); });
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
