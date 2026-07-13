'use strict';
// 3 个并发 session（真实 puppeteer），验证：各自只见自己的页、各自独立窗口+vnc 端口。
const puppeteer = require('puppeteer-core');
const { httpGetJson, waitManifest } = require('../lib/cdp');
const BROKER_PORT = process.env.ACS_BROKER_PORT || 9300;
const BROKER = `http://127.0.0.1:${BROKER_PORT}`;

async function mk(tag) {
  const token = tag + Date.now() + Math.floor(Math.random() * 1e6).toString(16);
  const ws = `ws://127.0.0.1:${BROKER_PORT}/s/${token}/devtools/browser/x${Math.random().toString(16).slice(2)}`;
  const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
  const page = await browser.newPage();
  await page.goto(`data:text/html,<title>${tag}</title><body style="background:#123"><h1>${tag}</h1>`);
  return { token, browser, page, tag };
}

(async () => {
  const S = await Promise.all([mk('S1'), mk('S2'), mk('S3')]);
  await new Promise((r) => setTimeout(r, 1500));

  const titles = [];
  for (const s of S) {
    const pages = await s.browser.pages();
    const ts = await Promise.all(pages.map((p) => p.title().catch(() => '')));
    titles.push({ tag: s.tag, pageCount: pages.length, titles: ts });
  }
  // 各自只见 1 个页，且就是自己的 tag
  const isolated = titles.every((t, i) => t.pageCount === 1 && t.titles[0] === S[i].tag);

  // 各自独立窗口 + 独立 vnc 端口
  const mans = await Promise.all(S.map((s) => waitManifest(BROKER, s.token)));
  const wins = new Set(mans.map((m) => m.primaryWindowId));
  const vncs = new Set(mans.map((m) => m.vncPort));
  const distinct = wins.size === 3 && vncs.size === 3;

  console.log('per-session:', JSON.stringify(titles));
  console.log('windows:', [...wins], 'vncPorts:', [...vncs]);
  const pass = isolated && distinct;
  console.log(pass ? 'PASS: 3 session 各自隔离、独立窗口+VNC' : 'FAIL');

  await Promise.all(S.map((s) => s.browser.disconnect()));
  setTimeout(() => process.exit(pass ? 0 : 1), 800);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
