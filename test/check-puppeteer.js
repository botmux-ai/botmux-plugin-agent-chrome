'use strict';
// 用真正的 puppeteer（chrome-devtools-mcp 底层就是它）连 broker，
// 验证：连接成功、newPage 可用、各 session 的 browser.pages() 只见自己的页、
// 截图正常。这一步过了，说明未改动的 MCP 也能正常工作且被隔离。
const puppeteer = require('puppeteer-core');

const BROKER_PORT = process.env.ACS_BROKER_PORT || 9300;
const BROKER = `http://127.0.0.1:${BROKER_PORT}`;
const TA = 'pptrA' + Date.now();
const TB = 'pptrB' + Date.now();

async function sess(token, color, text) {
  // 用 wsEndpoint：token 在 ws 路径里，puppeteer 直连不走 /json/version（路径不会被吞）
  const wsEndpoint = `ws://127.0.0.1:${BROKER_PORT}/s/${token}/devtools/browser/${Math.random().toString(16).slice(2)}`;
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  const page = await browser.newPage();
  await page.goto(`data:text/html,<body style="margin:0;background:${color}"><h1 style="color:#fff;font-size:90px">${text}</h1></body>`);
  return { browser, page };
}

(async () => {
  const A = await sess(TA, 'rgb(160,30,30)', 'AGENT-A');
  const B = await sess(TB, 'rgb(30,30,160)', 'AGENT-B');
  await new Promise((r) => setTimeout(r, 1500));

  const aPages = await A.browser.pages();
  const bPages = await B.browser.pages();
  const aUrls = aPages.map((p) => p.url());
  const bUrls = bPages.map((p) => p.url());
  console.log('A.pages():', aPages.length, aUrls.map((u) => u.slice(0, 45)));
  console.log('B.pages():', bPages.length, bUrls.map((u) => u.slice(0, 45)));

  // 隔离：A 只应看到含 AGENT-A 的页，看不到 AGENT-B
  const aOnlyA = aUrls.some((u) => u.includes('AGENT-A')) && !aUrls.some((u) => u.includes('AGENT-B'));
  const bOnlyB = bUrls.some((u) => u.includes('AGENT-B')) && !bUrls.some((u) => u.includes('AGENT-A'));

  // 截图可用（功能正常）
  const shotA = await A.page.screenshot({ encoding: 'base64' });
  const shotOk = shotA.length > 1000;

  // viewport/DPR 仍对齐 16"
  const vp = await A.page.evaluate(() => ({ dpr: devicePixelRatio, w: innerWidth, h: innerHeight }));
  console.log('A viewport:', JSON.stringify(vp));

  console.log(JSON.stringify({ aOnlyA, bOnlyB, shotOk, dpr2: vp.dpr === 2, w1728: vp.w === 1728 }, null, 2));
  const pass = aOnlyA && bOnlyB && shotOk && vp.dpr === 2 && vp.w === 1728;
  console.log(pass ? 'PASS: 真实 puppeteer/MCP 路径正常且被隔离' : 'FAIL');

  await A.browser.disconnect(); await B.browser.disconnect();
  setTimeout(() => process.exit(pass ? 0 : 1), 800);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
