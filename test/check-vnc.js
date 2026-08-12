'use strict';
// per-session x11vnc + noVNC 就绪，并能按自己的窗口截图。
const { CDP, waitManifest } = require('../lib/cdp');
const { execSync } = require('child_process');
const fs = require('fs');

const BROKER = `http://127.0.0.1:${process.env.ACS_BROKER_PORT || 9300}`;
const DISPLAY = process.env.ACS_DISPLAY || ':77';
const TOKEN = 'vnc' + Date.now();

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

(async () => {
  const cdp = await CDP.connectBrowser(`${BROKER}/s/${TOKEN}`);
  const { targetId } = await cdp.send('Target.createTarget',
    { url: 'data:text/html,<body style="margin:0;background:rgb(20,140,90)"><h1 style="color:white;font-size:80px">VNC OK</h1>', newWindow: true, width: 1728, height: 1117 });
  const mf = await waitManifest(BROKER, TOKEN);
  console.log('target:', targetId);
  console.log('manifest:', JSON.stringify(mf, null, 2));

  const ports = sh(`ss -ltnp | grep -E ':(${mf.vncPort}|${mf.novncPort})\\b' || true`);
  const f = `/tmp/acs-test-vnc-${TOKEN}.png`;
  let shotOk = false;
  if (mf && mf.primaryWindowId) {
    sh(`DISPLAY=${DISPLAY} import -window ${mf.primaryWindowId} ${f} 2>/dev/null`);
    shotOk = fs.existsSync(f) && fs.statSync(f).size > 1000;
    try { fs.unlinkSync(f); } catch {}
  }
  console.log(ports);
  const pass = Boolean(mf && mf.novncUrl && /vnc.html/.test(mf.novncUrl) && /#password=/.test(mf.novncUrl) && ports.includes(String(mf.vncPort)) && ports.includes(String(mf.novncPort)) && shotOk);
  console.log(pass ? 'PASS: noVNC/x11vnc 就绪且窗口可截图' : 'FAIL');
  cdp.close();
  setTimeout(() => process.exit(pass ? 0 : 1), 500);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
