'use strict';
// 验证 CDP target 能映射到 X11 window-id，且通过窗口 id 可独立截图。
const { CDP, waitManifest } = require('../lib/cdp');
const { execSync } = require('child_process');
const fs = require('fs');

const BROKER = 'http://127.0.0.1:9300';
const TOKEN = 'winmap' + Date.now();

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

(async () => {
  const cdp = await CDP.connectBrowser(`${BROKER}/s/${TOKEN}`);
  const { targetId } = await cdp.send('Target.createTarget', {
    url: 'about:blank', newWindow: true, width: 1728, height: 1117,
  });
  const mf = await waitManifest(BROKER, TOKEN);
  const winId = mf && mf.primaryWindowId;
  let geom = '';
  let shotOk = false;
  if (winId) {
    geom = sh(`DISPLAY=:77 xdotool getwindowgeometry --shell ${winId}`);
    const f = `/tmp/acs-window-map-${TOKEN}.png`;
    sh(`DISPLAY=:77 import -window ${winId} ${f} 2>/dev/null`);
    shotOk = fs.existsSync(f) && fs.statSync(f).size > 1000;
    try { fs.unlinkSync(f); } catch {}
  }
  console.log('target:', targetId);
  console.log('manifest:', JSON.stringify(mf));
  console.log('geometry:', geom.replace(/\n/g, ' '));
  const pass = Boolean(winId && mf.targets.includes(targetId) && /WIDTH=|HEIGHT=/.test(geom) && shotOk);
  console.log(pass ? 'PASS: 窗口 id 映射与单窗口截图正常' : 'FAIL');
  cdp.close();
  setTimeout(() => process.exit(pass ? 0 : 1), 500);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
