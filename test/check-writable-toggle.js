'use strict';
// noVNC 默认只读，可切到可写再切回只读。
const { CDP, httpGetJson, waitManifest } = require('../lib/cdp');

const BROKER = `http://127.0.0.1:${process.env.ACS_BROKER_PORT || 9300}`;
const TOKEN = 'writable' + Date.now();

(async () => {
  const cdp = await CDP.connectBrowser(`${BROKER}/s/${TOKEN}`);
  await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, width: 1728, height: 1117 });
  const mf0 = await waitManifest(BROKER, TOKEN);
  const off = await httpGetJson(`${BROKER}/s/${TOKEN}/viewonly?on=0`);
  await new Promise((r) => setTimeout(r, 500));
  const mf1 = await httpGetJson(`${BROKER}/s/${TOKEN}/manifest`);
  const on = await httpGetJson(`${BROKER}/s/${TOKEN}/viewonly?on=1`);
  await new Promise((r) => setTimeout(r, 500));
  const mf2 = await httpGetJson(`${BROKER}/s/${TOKEN}/manifest`);

  console.log(JSON.stringify({ initial: mf0 && mf0.viewonly, off, afterOff: mf1.viewonly, on, afterOn: mf2.viewonly }, null, 2));
  const pass = Boolean(mf0 && mf0.viewonly === true && off.ok && mf1.viewonly === false && on.ok && mf2.viewonly === true);
  console.log(pass ? 'PASS: 只读/可写切换正常' : 'FAIL');
  cdp.close();
  setTimeout(() => process.exit(pass ? 0 : 1), 500);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
