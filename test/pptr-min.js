'use strict';
const puppeteer = require('puppeteer-core');

(async () => {
  const ws = `ws://127.0.0.1:${process.env.ACS_BROKER_PORT || 9300}/s/min${Date.now()}/devtools/browser/x1`;
  const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
  const page = await browser.newPage();
  await page.goto('data:text/html,<h1>pptr-min</h1>');
  console.log(await page.title());
  await browser.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
