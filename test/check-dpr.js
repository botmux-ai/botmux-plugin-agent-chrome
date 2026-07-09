'use strict';
// 对齐 16" MBP：DPR=2、视口 1728x1117。
const { CDP, waitManifest } = require('../lib/cdp');

const BROKER = 'http://127.0.0.1:9300';
const TOKEN = 'dpr' + Date.now();

(async () => {
  const cdp = await CDP.connectBrowser(`${BROKER}/s/${TOKEN}`);
  const { targetId } = await cdp.send('Target.createTarget', {
    url: 'about:blank', newWindow: true,
    width: 1728, height: 1117,
  });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  const r = await cdp.send('Runtime.evaluate', {
    expression: '({ dpr: devicePixelRatio, w: innerWidth, h: innerHeight })',
    returnByValue: true,
  }, sessionId);
  const vp = r.result.value;
  const mf = await waitManifest(BROKER, TOKEN);
  console.log('viewport:', JSON.stringify(vp));
  console.log('manifest:', JSON.stringify(mf));
  const pass = vp.dpr === 2 && vp.w === 1728 && vp.h === 1117 && mf && mf.primaryWindowId;
  console.log(pass ? 'PASS: DPR/viewport 对齐 16 寸 MBP' : 'FAIL');
  cdp.close();
  setTimeout(() => process.exit(pass ? 0 : 1), 500);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
