'use strict';
// 极简 CDP-over-WebSocket 客户端：broker / 工具 / 测试共用。
const WebSocket = require('ws');
const http = require('http');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this._id = 0;
    this._pending = new Map();
    this._handlers = new Set();
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id !== undefined && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else {
        for (const h of this._handlers) h(msg);
      }
    });
  }
  static async connectBrowser(httpBase) {
    const v = await httpGetJson(httpBase + '/json/version');
    const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this._id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(fn) { this._handlers.add(fn); return () => this._handlers.delete(fn); }
  close() { try { this.ws.close(); } catch {} }
}

// 轮询 broker manifest，直到窗口和 noVNC 都可对外使用，或超时。
async function waitManifest(brokerBase, token, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const mf = await httpGetJson(`${brokerBase}/s/${token}/manifest`);
      if (mf && mf.primaryWindowId && mf.novncUrl) return mf;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

module.exports = { CDP, httpGetJson, waitManifest };
