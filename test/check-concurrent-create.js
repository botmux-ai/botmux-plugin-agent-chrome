'use strict';

// Regression for concurrent Target.createTarget ownership. Every Puppeteer
// connection auto-attaches to every Chrome tab with waitForDebuggerOnStart.
// The broker must assign the tab/page/session tuple to exactly one token and
// resume hidden foreign sessions, otherwise one client can leave another
// client's renderer paused forever.
const puppeteer = require('puppeteer-core');

const BROKER_PORT = process.env.ACS_BROKER_PORT || 9300;
const ROUNDS = Number(process.env.ACS_CONCURRENT_CREATE_ROUNDS || 12);
const CLIENTS = Number(process.env.ACS_CONCURRENT_CREATE_CLIENTS || 3);

async function connect(index) {
  const token = `concurrent-${index}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const browserWSEndpoint =
    `ws://127.0.0.1:${BROKER_PORT}/s/${token}/devtools/browser/${Math.random().toString(16).slice(2)}`;
  const browser = await puppeteer.connect({ browserWSEndpoint, defaultViewport: null });
  return { index, token, browser };
}

async function createAndVerify(client, round) {
  const marker = `client-${client.index}-round-${round}`;
  const page = await client.browser.newPage();
  try {
    await page.goto(`data:text/html,<title>${marker}</title><h1>${marker}</h1>`, {
      timeout: 10_000,
      waitUntil: 'load',
    });
    const state = await page.evaluate(() => ({
      title: document.title,
      body: document.body?.innerText || '',
      readyState: document.readyState,
    }));
    if (state.title !== marker || state.body !== marker || state.readyState !== 'complete') {
      throw new Error(`${marker} rendered unexpected state ${JSON.stringify(state)}`);
    }
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  const clients = await Promise.all(Array.from({ length: CLIENTS }, (_, i) => connect(i)));
  const startedAt = Date.now();
  try {
    for (let round = 0; round < ROUNDS; round++) {
      await Promise.all(clients.map((client) => createAndVerify(client, round)));
      const visible = await Promise.all(clients.map(async (client) => {
        const pages = await client.browser.pages();
        return pages.length;
      }));
      if (visible.some((count) => count !== 0)) {
        throw new Error(`round ${round} left visible/orphan pages: ${visible.join(',')}`);
      }
    }
  } finally {
    await Promise.all(clients.map((client) => client.browser.disconnect().catch(() => {})));
  }
  console.log(JSON.stringify({
    clients: CLIENTS,
    rounds: ROUNDS,
    creates: CLIENTS * ROUNDS,
    elapsedMs: Date.now() - startedAt,
  }));
  console.log('PASS: concurrent create ownership is stable');
})().catch((error) => {
  console.error('FAIL:', error);
  process.exit(1);
});
