'use strict';
/*
 * L3 Broker —— 多 Agent 规范 Chrome 的核心。
 *
 * 职责：
 *  1. 冒充 Chrome 调试端点：对每个 /s/<token> 暴露 /json/version + browser ws，
 *     让未改动的 chrome-devtools-mcp（puppeteer.connect）按老方式连过来。
 *  2. CDP 过滤隔离：每条 agent 连接独占一条到真 Chrome 的 upstream，
 *     按 token 维护 target 归属；过滤 Target.* 可见性、拒绝跨 owner 的 close/attach。
 *     → A 看不到也关不掉 B 的页面（硬隔离）。
 *  3. Session 视图：每个 token 维护 Page 列表、一个跟随 Agent 的 Follow VNC，
 *     以及按需创建且复用端口的 Free VNC；切 Page 只重绑 x11vnc。
 *  4. 旁路 HTTP：/s/<token>/manifest、视图控制、/sessions 提供 Dashboard 数据。
 */
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { execSync, spawn } = require('child_process');
const WebSocket = require('ws');
const { CDP, httpGetJson } = require('../lib/cdp');

const DATA_ROOT = process.env.ACS_DATA_ROOT
  || process.env.AGENT_CHROME_HOME
  || path.join(os.homedir(), '.agent-chrome');
const CFG = {
  display: process.env.ACS_DISPLAY || ':77',
  chromePort: parseInt(process.env.ACS_CHROME_PORT || '9223', 10),
  brokerPort: parseInt(process.env.ACS_BROKER_PORT || '9300', 10),
  vncBase: parseInt(process.env.ACS_VNC_BASE || '5910', 10),
  novncBase: parseInt(process.env.ACS_NOVNC_BASE || '6090', 10),
  novncWeb: process.env.ACS_NOVNC_WEB || '/usr/share/novnc',
  manifests: process.env.ACS_MANIFESTS || path.join(DATA_ROOT, 'run', 'manifests'),
  logs: process.env.ACS_LOGS || path.join(DATA_ROOT, 'logs'),
  reconnectGraceMs: parseInt(process.env.ACS_RECONNECT_GRACE_MS || '30000', 10),
};

fs.mkdirSync(CFG.manifests, { recursive: true });
fs.mkdirSync(CFG.logs, { recursive: true });

function log(...a) { console.log(new Date().toISOString(), '[broker]', ...a); }
function xdo(cmd) { return execSync(`DISPLAY=${CFG.display} ${cmd}`, { encoding: 'utf8' }).trim(); }
function hostHint() {
  try { return execSync("hostname -I", { encoding: 'utf8' }).trim().split(/\s+/)[0] || '127.0.0.1'; }
  catch { return '127.0.0.1'; }
}
const HOST = hostHint();
const SERVICE_INSTANCE_ID = process.env.ACS_SERVICE_INSTANCE_ID || null;

let chromeBrowserWsUrl = null;       // 真 Chrome 的 browser ws
let control = null;                  // broker 自用控制连接（provisioning）
const targetOwner = new Map();       // targetId -> stable session key
const sessions = new Map();          // stable session key -> session state
const transportBindings = new Map(); // MCP transport token -> stable session key
const usedPortSlots = new Set();     // Follow / Free VNC 共用端口池
const mappedWindows = new Set();     // 已分配的 X11 window-id（全局，供"新窗口差集"映射）
let provChain = Promise.resolve();   // provisioning 串行化队列（避免并发映射歧义）

async function ensureChrome() {
  const v = await httpGetJson(`http://127.0.0.1:${CFG.chromePort}/json/version`);
  chromeBrowserWsUrl = v.webSocketDebuggerUrl;
  control = await CDP.connectBrowser(`http://127.0.0.1:${CFG.chromePort}`);
  await control.send('Target.setDiscoverTargets', { discover: true });
  control.on((message) => {
    const method = message.method || '';
    if (method === 'Target.targetInfoChanged') {
      const targetInfo = message.params?.targetInfo;
      const owner = targetInfo ? targetOwner.get(targetInfo.targetId) : null;
      if (owner) recordTargetInfo(owner, targetInfo);
      return;
    }
    if (method === 'Target.targetDestroyed') {
      const targetId = message.params?.targetId;
      const owner = targetId ? targetOwner.get(targetId) : null;
      if (owner) removePage(owner, targetId);
    }
  });
  log('connected control to real chrome', chromeBrowserWsUrl);
  // chrome 挂了（OOM/重启）→ 控制连接断 → 退出，交给 systemd 重启本进程，
  // 其 ExecStartPre 会等 chrome 回来后重连，实现自愈。
  control.ws.on('close', () => { log('control connection to chrome lost → exiting for restart'); process.exit(1); });
  control.ws.on('error', () => { log('control connection error → exiting for restart'); process.exit(1); });
}

function getSession(token, metadata = {}) {
  let s = sessions.get(token);
  if (!s) {
    s = {
      token,
      accessToken: metadata.accessToken || token,
      botmuxSessionId: null,
      pages: new Map(),
      cdpSessions: new Map(),
      agentActiveTargetId: null,
      freeTargetId: null,
      freeHistory: [],
      freeEnabled: false,
      followVnc: null,
      freeVnc: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      connCount: 0,
      teardownTimer: null,
    };
    sessions.set(token, s);
  }
  if (!s.accessToken && typeof metadata.accessToken === 'string') s.accessToken = metadata.accessToken;
  if (typeof metadata.botmuxSessionId === 'string' && metadata.botmuxSessionId.trim()) {
    s.botmuxSessionId = metadata.botmuxSessionId.trim().slice(0, 256);
    s.updatedAt = Date.now();
  }
  return s;
}

function normalizeSessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('invalid_session_id');
  }
  return value;
}

function resolveSessionKey(transportToken) {
  const bound = transportBindings.get(transportToken);
  if (bound) return bound;
  const legacy = sessions.get(transportToken);
  return legacy?.accessToken === transportToken && !legacy.botmuxSessionId ? transportToken : null;
}

function resolveWebSocketSessionKey(transportToken) {
  const bound = transportBindings.get(transportToken);
  if (bound) return bound;
  const existing = sessions.get(transportToken);
  if (existing?.botmuxSessionId) return null;
  return transportToken;
}

function bindTransport(transportToken, rawSessionId) {
  const sessionId = normalizeSessionId(rawSessionId);
  const existing = transportBindings.get(transportToken);
  if (existing && existing !== sessionId) throw new Error('transport_already_bound');
  transportBindings.set(transportToken, sessionId);
  const session = getSession(sessionId, { accessToken: transportToken, botmuxSessionId: sessionId });
  if (session.teardownTimer) {
    clearTimeout(session.teardownTimer);
    session.teardownTimer = null;
  }
  touch(session);
  writeManifest(sessionId);
  if (session.connCount <= 0) scheduleTeardown(sessionId);
  return sessionId;
}

function touch(s) { s.updatedAt = Date.now(); }

function ensurePage(s, targetId) {
  let page = s.pages.get(targetId);
  if (!page) {
    const now = Date.now();
    page = { targetId, winId: null, cdpWindowId: null, title: '', url: '', createdAt: now, lastActiveAt: now };
    s.pages.set(targetId, page);
    touch(s);
  }
  return page;
}

function recordTargetInfo(token, targetInfo) {
  if (!targetInfo || targetInfo.type !== 'page' || targetOwner.get(targetInfo.targetId) !== token) return;
  const s = getSession(token);
  const page = ensurePage(s, targetInfo.targetId);
  if (typeof targetInfo.title === 'string') page.title = targetInfo.title;
  if (typeof targetInfo.url === 'string') page.url = targetInfo.url;
  touch(s);
  writeManifest(token);
}

function refreshTargetInfoLater(token, targetId, delayMs = 600) {
  const timer = setTimeout(async () => {
    if (!sessions.has(token) || targetOwner.get(targetId) !== token) return;
    try {
      const { targetInfo } = await control.send('Target.getTargetInfo', { targetId });
      recordTargetInfo(token, targetInfo);
    } catch (error) {
      log(`target metadata refresh warn target=${targetId.slice(0, 8)}: ${error.message}`);
    }
  }, delayMs);
  timer.unref();
}

function mostRecentPage(s) {
  return [...s.pages.values()]
    .filter((page) => page.winId)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt || b.createdAt - a.createdAt)[0] || null;
}

function freeFallbackPage(s) {
  for (let i = s.freeHistory.length - 1; i >= 0; i--) {
    const page = s.pages.get(s.freeHistory[i]);
    if (page?.winId) return page;
  }
  const active = s.pages.get(s.agentActiveTargetId);
  return active?.winId ? active : mostRecentPage(s);
}

function activatePageWindow(page) {
  const winId = String(page?.winId || '');
  if (!/^\d+$/.test(winId)) return false;
  try {
    xdo(`xdotool windowmap ${winId} windowraise ${winId} windowactivate --sync ${winId}`);
    return true;
  } catch (error) {
    log(`window activate warn win=${winId}: ${error.message}`);
    return false;
  }
}

function allocatePorts() {
  let slot = 0;
  while (usedPortSlots.has(slot)) slot++;
  usedPortSlots.add(slot);
  return { slot, vncPort: CFG.vncBase + slot, novncPort: CFG.novncBase + slot };
}

function x11vncArgs(view) {
  const args = ['-id', String(view.winId), '-display', CFG.display, '-rfbport', String(view.vncPort),
    '-localhost', '-forever', '-shared', '-nopw', '-noxdamage', '-quiet'];
  if (view.viewonly) args.push('-viewonly');
  return args;
}

function spawnX11vnc(view) {
  const logFile = `${CFG.logs}/x11vnc-${view.vncPort}.log`;
  return spawn('x11vnc', x11vncArgs(view), {
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
  });
}

function watchNovncProcess(s, kind, view) {
  const child = view.novncProc;
  let failed = false;
  const markFailed = (reason) => {
    if (failed || !sessions.has(s.token) || s[`${kind}Vnc`] !== view) return;
    failed = true;
    view.ready = false;
    view.error = reason;
    touch(s);
    writeManifest(s.token);
    log(`${kind} vnc failed token=${s.token.slice(0, 8)}: ${reason}`);
  };
  child.once('error', (error) => markFailed(`websockify failed to start: ${error.message}`));
  child.once('exit', (code, signal) => {
    const outcome = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    markFailed(`websockify exited with ${outcome}`);
  });
}

function terminateChild(child, forceAfterMs = 180) {
  if (!child || child.exitCode !== null) return;
  try { child.kill('SIGTERM'); } catch {}
  const timer = setTimeout(() => {
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }, forceAfterMs);
  timer.unref();
}

function waitForTcp(port, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (ok) resolve();
        else if (Date.now() >= deadline) reject(new Error(`port ${port} did not become ready`));
        else setTimeout(attempt, 50);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(300, () => finish(false));
    };
    attempt();
  });
}

function startVnc(s, kind, page) {
  const ports = allocatePorts();
  const view = {
    kind,
    targetId: page.targetId,
    winId: page.winId,
    viewonly: true,
    ...ports,
    vncProc: null,
    novncProc: null,
    rebindTimer: null,
    ready: false,
    error: null,
  };
  view.vncProc = spawnX11vnc(view);
  const novncLog = `${CFG.logs}/novnc-${view.novncPort}.log`;
  view.novncProc = spawn('websockify', [
    `--web=${CFG.novncWeb}`,
    `0.0.0.0:${view.novncPort}`,
    `localhost:${view.vncPort}`,
  ], {
    stdio: ['ignore', fs.openSync(novncLog, 'a'), fs.openSync(novncLog, 'a')],
  });
  view.novncUrl = `http://${HOST}:${view.novncPort}/vnc.html?autoconnect=true&reconnect=true&reconnect_delay=1000&resize=scale&path=websockify`;
  s[`${kind}Vnc`] = view;
  watchNovncProcess(s, kind, view);
  touch(s);
  void Promise.all([waitForTcp(view.vncPort), waitForTcp(view.novncPort)])
    .then(() => {
      if (!sessions.has(s.token) || s[`${kind}Vnc`] !== view) return;
      if (view.error || view.novncProc.exitCode !== null || view.novncProc.signalCode) return;
      view.ready = true;
      touch(s);
      writeManifest(s.token);
    })
    .catch((error) => {
      if (!sessions.has(s.token) || s[`${kind}Vnc`] !== view) return;
      view.error = error.message;
      touch(s);
      writeManifest(s.token);
      log(`${kind} vnc failed token=${s.token.slice(0, 8)}: ${error.message}`);
    });
  log(`${kind} vnc up token=${s.token.slice(0, 8)} target=${page.targetId.slice(0, 8)} win=${page.winId} vnc=${view.vncPort} novnc=${view.novncPort}`);
  return view;
}

function restartX11vnc(s, view) {
  terminateChild(view.vncProc);
  if (view.rebindTimer) clearTimeout(view.rebindTimer);
  view.ready = false;
  view.error = null;
  view.rebindTimer = setTimeout(() => {
    if (!sessions.has(s.token) || s[`${view.kind}Vnc`] !== view) return;
    view.vncProc = spawnX11vnc(view);
    view.rebindTimer = null;
    touch(s);
    writeManifest(s.token);
    void waitForTcp(view.vncPort)
      .then(() => {
        if (!sessions.has(s.token) || s[`${view.kind}Vnc`] !== view) return;
        view.ready = true;
        touch(s);
        writeManifest(s.token);
      })
      .catch((error) => {
        if (!sessions.has(s.token) || s[`${view.kind}Vnc`] !== view) return;
        view.error = error.message;
        touch(s);
        writeManifest(s.token);
      });
  }, 300);
}

async function waitForViewReady(s, kind, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = s?.[`${kind}Vnc`];
    if (!view) return false;
    if (view.error) return false;
    if (view.ready && !view.rebindTimer) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

function ensureVnc(s, kind, targetId) {
  const page = s.pages.get(targetId);
  if (!page?.winId) return null;
  const current = s[`${kind}Vnc`];
  if (!current) return startVnc(s, kind, page);
  if (current.targetId !== targetId || current.winId !== page.winId) {
    current.targetId = targetId;
    current.winId = page.winId;
    restartX11vnc(s, current);
    touch(s);
    log(`${kind} vnc rebind token=${s.token.slice(0, 8)} target=${targetId.slice(0, 8)} win=${page.winId}`);
  }
  return current;
}

function disposeVnc(s, kind) {
  const view = s[`${kind}Vnc`];
  if (!view) return;
  if (view.rebindTimer) clearTimeout(view.rebindTimer);
  terminateChild(view.vncProc);
  terminateChild(view.novncProc);
  usedPortSlots.delete(view.slot);
  s[`${kind}Vnc`] = null;
  touch(s);
  log(`${kind} vnc down token=${s.token.slice(0, 8)}`);
}

function markAgentActive(token, targetId) {
  if (!targetId || targetOwner.get(targetId) !== token) return;
  const s = getSession(token);
  const page = ensurePage(s, targetId);
  const targetChanged = s.agentActiveTargetId !== targetId;
  page.lastActiveAt = Date.now();
  s.agentActiveTargetId = targetId;
  if (!s.freeEnabled && targetChanged) activatePageWindow(page);
  if (page.winId) ensureVnc(s, 'follow', targetId);
  touch(s);
  writeManifest(token);
}

function selectFreeTarget(s, targetId) {
  const page = s.pages.get(targetId);
  if (!page?.winId) return false;
  s.freeTargetId = targetId;
  s.freeHistory = s.freeHistory.filter((id) => id !== targetId);
  s.freeHistory.push(targetId);
  activatePageWindow(page);
  ensureVnc(s, 'free', targetId);
  touch(s);
  writeManifest(s.token);
  return true;
}

function setViewMode(token, mode) {
  const s = sessions.get(token);
  if (!s || !['follow', 'free'].includes(mode)) return null;
  if (mode === 'follow') {
    s.freeEnabled = false;
    s.freeTargetId = null;
    disposeVnc(s, 'free');
    const page = s.pages.get(s.agentActiveTargetId) || mostRecentPage(s);
    if (page) activatePageWindow(page);
  } else {
    s.freeEnabled = true;
    const page = freeFallbackPage(s);
    if (page) selectFreeTarget(s, page.targetId);
  }
  touch(s);
  writeManifest(token);
  return manifestFor(token);
}

function setViewonly(token, viewonly, mode = 'follow') {
  const s = sessions.get(token);
  const kind = mode === 'free' ? 'free' : 'follow';
  const view = s?.[`${kind}Vnc`];
  if (!s || !view) return false;
  view.viewonly = viewonly;
  restartX11vnc(s, view);
  touch(s);
  writeManifest(token);
  return true;
}

function removePage(token, targetId) {
  const s = sessions.get(token);
  const page = s?.pages.get(targetId);
  if (!s || !page) return;
  s.pages.delete(targetId);
  if (page.winId) mappedWindows.delete(page.winId);
  targetOwner.delete(targetId);
  for (const [sessionId, mappedTarget] of s.cdpSessions) {
    if (mappedTarget === targetId) s.cdpSessions.delete(sessionId);
  }
  s.freeHistory = s.freeHistory.filter((id) => id !== targetId);

  if (s.pages.size === 0) {
    s.agentActiveTargetId = null;
    s.freeTargetId = null;
    s.freeEnabled = false;
    disposeVnc(s, 'follow');
    disposeVnc(s, 'free');
  } else {
    if (s.agentActiveTargetId === targetId) {
      const next = mostRecentPage(s);
      s.agentActiveTargetId = next?.targetId || null;
      if (next) {
        if (!s.freeEnabled) activatePageWindow(next);
        ensureVnc(s, 'follow', next.targetId);
      }
    }
    if (s.freeTargetId === targetId) {
      const next = freeFallbackPage(s);
      s.freeTargetId = next?.targetId || null;
      if (s.freeEnabled && next) ensureVnc(s, 'free', next.targetId);
      else disposeVnc(s, 'free');
    }
  }
  touch(s);
  writeManifest(token);
}

function acsWindows() {
  try { return xdo('xdotool search --class acs-chrome').split('\n').filter(Boolean); }
  catch { return []; }
}
function winX(w) {
  try { const o = xdo(`xdotool getwindowgeometry --shell ${w}`); const m = o.match(/\bX=(-?\d+)/); return m ? parseInt(m[1], 10) : null; }
  catch { return null; }
}

let probeCursor = 0;
const DPR = parseInt(process.env.ACS_DPR || '2', 10);
const LOGICAL_W = parseInt(process.env.ACS_LOGICAL_W || '1728', 10);
const LOGICAL_H = parseInt(process.env.ACS_LOGICAL_H || '1117', 10);
// 把 CDP windowId(target) 映射到 X11 window-id —— 位置探针法（race-free）：
// broker 把该窗口移到一个唯一的物理 X 坐标（agent 无法改窗口位置/几何），
// 再找处于该坐标附近的、尚未分配的 acs-chrome 窗口即是它，然后还原成 kiosk 全屏。
// 与标题/导航无关；CDP 用逻辑像素，xdotool 读物理像素，按 DPR 换算。
async function mapWindow(cdpWindowId) {
  const physX = 300 + (probeCursor++ % 14) * 200;      // 唯一探针物理 X（间距 200，远大于 ±25 容差）
  const logicalLeft = Math.round(physX / DPR);
  try {
    await control.send('Browser.setWindowBounds', { windowId: cdpWindowId, bounds: { windowState: 'normal' } });
    await control.send('Browser.setWindowBounds', { windowId: cdpWindowId, bounds: { left: logicalLeft, top: 13, width: 240, height: 200 } });
  } catch (e) { log('probe move warn', e.message); }

  let winId = null;
  for (let i = 0; i < 80; i++) {
    const all = acsWindows().filter((w) => !mappedWindows.has(w)).map((w) => ({ w, x: winX(w) }));
    const cands = all.filter((c) => c.x !== null && Math.abs(c.x - physX) <= 25);
    if (cands.length >= 1) { winId = cands.sort((a, b) => Math.abs(a.x - physX) - Math.abs(b.x - physX))[0].w; break; }
    if (process.env.ACS_DEBUG === '1' && i === 40) log('probe miss physX=' + physX, 'unmapped=', JSON.stringify(all.map((c) => c.x)));
    await new Promise((r) => setTimeout(r, 30));
  }
  // kiosk：fullscreen 状态去掉 WM 装饰，内容区精确 = 1728x1117（对齐 16" MBP）
  try { await control.send('Browser.setWindowBounds', { windowId: cdpWindowId,
    bounds: { windowState: 'fullscreen' } }); } catch {}
  return winId;
}

// 反应式：为某 token 的新 target 分配 kiosk 窗口 + x11vnc + noVNC（串行执行）
function provision(token, targetId) {
  provChain = provChain.then(() => provisionOne(token, targetId)).catch((e) => log('provision error', e.message));
  return provChain;
}
async function provisionOne(token, targetId) {
  const s = getSession(token);
  if (!sessions.has(token)) return; // 会话已结束
  if (s.pages.get(targetId)?.winId) return;
  let cdpWindowId;
  try { ({ windowId: cdpWindowId } = await control.send('Browser.getWindowForTarget', { targetId })); }
  catch (e) { log('getWindowForTarget warn', e.message); return; }

  const winId = await mapWindow(cdpWindowId);
  if (!winId) { log('WARN: X11 window-id not found for', targetId.slice(0, 8)); return; }
  if (!sessions.has(token) || targetOwner.get(targetId) !== token) return;
  mappedWindows.add(winId);
  const page = ensurePage(s, targetId);
  if (page.winId) return;
  page.cdpWindowId = cdpWindowId;
  page.winId = winId;
  try {
    const { targetInfo } = await control.send('Target.getTargetInfo', { targetId });
    recordTargetInfo(token, targetInfo);
  } catch (error) {
    log(`target metadata warn target=${targetId.slice(0, 8)}: ${error.message}`);
  }
  refreshTargetInfoLater(token, targetId);
  refreshTargetInfoLater(token, targetId, 1800);
  if (!s.agentActiveTargetId) s.agentActiveTargetId = targetId;
  if (!s.freeEnabled && s.agentActiveTargetId === targetId) activatePageWindow(page);
  ensureVnc(s, 'follow', s.agentActiveTargetId);
  if (s.freeEnabled && !selectFreeTarget(s, s.freeTargetId || targetId)) selectFreeTarget(s, targetId);
  touch(s);
  writeManifest(token);
  log(`provisioned token=${token.slice(0,8)} target=${targetId.slice(0,8)} win=${winId}`);
}

function publicVnc(view) {
  if (!view) return null;
  return {
    targetId: view.targetId,
    windowId: view.winId,
    vncPort: view.vncPort,
    novncPort: view.novncPort,
    novncUrl: view.ready ? view.novncUrl : null,
    viewonly: view.viewonly,
    status: view.error ? 'error' : (!view.ready ? 'starting' : (view.rebindTimer ? 'reconnecting' : 'connected')),
    ...(view.error ? { error: view.error } : {}),
  };
}

function manifestFor(token) {
  const s = sessions.get(token);
  if (!s) return null;
  const primary = s.followVnc;
  const publicPrimary = publicVnc(primary);
  const pages = [...s.pages.values()]
    .filter((page) => page.winId)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.createdAt - b.createdAt)
    .map((page) => ({
      targetId: page.targetId,
      windowId: page.winId,
      title: page.title,
      url: page.url,
      createdAt: page.createdAt,
      lastActiveAt: page.lastActiveAt,
    }));
  return {
    token: s.accessToken,
    botmuxSessionId: s.botmuxSessionId,
    DISPLAY: CFG.display,
    geometry: `${process.env.ACS_LOGICAL_W || 1728}x${process.env.ACS_LOGICAL_H || 1117}@${process.env.ACS_DPR || 2}x`,
    windowIds: pages.map((page) => page.windowId),
    primaryWindowId: primary ? primary.winId : null,
    vncPort: primary ? primary.vncPort : null,
    novncPort: primary ? primary.novncPort : null,
    novncUrl: publicPrimary?.novncUrl || null,
    viewonly: primary?.viewonly !== false,
    targets: pages.map((page) => page.targetId),
    pages,
    mode: s.freeEnabled ? 'free' : 'follow',
    agentActiveTargetId: s.agentActiveTargetId,
    follow: publicPrimary,
    free: s.freeVnc
      ? { enabled: s.freeEnabled, ...publicVnc(s.freeVnc) }
      : { enabled: s.freeEnabled },
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}
function writeManifest(token) {
  const m = manifestFor(token);
  if (!m) return;
  fs.writeFileSync(path.join(CFG.manifests, token + '.json'), JSON.stringify(m, null, 2));
}

function teardown(token) {
  const s = sessions.get(token);
  if (!s) return;
  if (s.teardownTimer) clearTimeout(s.teardownTimer);
  disposeVnc(s, 'follow');
  disposeVnc(s, 'free');
  // 关掉该 token 的所有窗口/target
  for (const page of s.pages.values()) {
    control.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    targetOwner.delete(page.targetId);
    if (page.winId) mappedWindows.delete(page.winId);
  }
  try { fs.unlinkSync(path.join(CFG.manifests, token + '.json')); } catch {}
  sessions.delete(token);
  for (const [transportToken, sessionKey] of transportBindings) {
    if (sessionKey === token) transportBindings.delete(transportToken);
  }
  log('teardown token=' + token.slice(0, 8));
}

function scheduleTeardown(token) {
  const s = sessions.get(token);
  if (!s || s.connCount > 0 || s.teardownTimer) return;
  s.teardownTimer = setTimeout(() => {
    s.teardownTimer = null;
    if (s.connCount <= 0) teardown(token);
  }, CFG.reconnectGraceMs);
  s.teardownTimer.unref();
  log(`teardown scheduled token=${token.slice(0, 8)} grace=${CFG.reconnectGraceMs}ms`);
}

// ---- 每条 agent 连接的 CDP 过滤代理 ----
function attachProxy(agentWs, token) {
  // 连接引用计数：同一 token 可有多条连接（holder + 偶发探测）；
  // 只有最后一条连接关闭才 teardown —— 避免一个瞬时连接拆掉整个会话。
  const sessionState = getSession(token);
  if (sessionState.teardownTimer) {
    clearTimeout(sessionState.teardownTimer);
    sessionState.teardownTimer = null;
  }
  sessionState.connCount++;
  const up = new WebSocket(chromeBrowserWsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  const ownedTargets = new Set();
  const myTabs = new Set();                  // 本 token 的 tab target（在 createTarget 窗口内出现）
  const hiddenSessions = new Set();
  const pendingCreate = new Set();          // 本连接 Target.createTarget 的命令 id
  let lastCreateAt = 0;                       // 最近一次 createTarget 时刻（tab 归属判定的宽限窗口）
  const midCreate = () => pendingCreate.size > 0 || (Date.now() - lastCreateAt < 1000);
  const pendingGetTargets = new Set();      // 本连接 Target.getTargets 的命令 id（需过滤结果）
  // 归属未定的 Target 事件先缓冲（解决 attachedToTarget 早于 createTarget 结果的竞态）：
  //   targetId -> { msgs:[], sessionIds:Set, timer }
  const pendingByTarget = new Map();
  const BUF_MS = 1200;
  function recordOwnedEvent(message) {
    const method = message.method || '';
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      recordTargetInfo(token, message.params?.targetInfo);
    } else if (method === 'Target.attachedToTarget') {
      const targetInfo = message.params?.targetInfo;
      if (targetInfo?.type === 'page' && message.params?.sessionId) {
        sessionState.cdpSessions.set(message.params.sessionId, targetInfo.targetId);
        recordTargetInfo(token, targetInfo);
      }
    }
  }
  function flushOwned(t) {                   // 该 target 被本连接认领 → 缓冲事件作为"自己的"放行
    const e = pendingByTarget.get(t); if (!e) return;
    clearTimeout(e.timer); pendingByTarget.delete(t);
    for (const msg of e.msgs) { recordOwnedEvent(msg); sendDown(msg); }
  }
  function dropUnclaimed(t) {                 // 超时未认领 → 判定为别人的，隐藏其 session、丢弃事件
    const e = pendingByTarget.get(t); if (!e) return;
    pendingByTarget.delete(t);
    for (const sid of e.sessionIds) hiddenSessions.add(sid);
  }
  function bufferEvent(t, msg, sid) {
    let e = pendingByTarget.get(t);
    if (!e) { e = { msgs: [], sessionIds: new Set(), timer: setTimeout(() => dropUnclaimed(t), BUF_MS) };
      pendingByTarget.set(t, e); }
    e.msgs.push(msg); if (sid) e.sessionIds.add(sid);
  }

  const sendDown = (obj) => { if (agentWs.readyState === WebSocket.OPEN) agentWs.send(JSON.stringify(obj)); };
  const sendUp = (obj) => { if (up.readyState === WebSocket.OPEN) up.send(JSON.stringify(obj)); };
  const queue = [];
  up.on('open', () => { for (const m of queue) up.send(m); queue.length = 0; });
  const rawUp = (s) => { if (up.readyState === WebSocket.OPEN) up.send(s); else queue.push(s); };

  const DBG = process.env.ACS_DEBUG === '1';
  // agent -> chrome
  agentWs.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const method = m.method || '';
    if (DBG) log('A→C', m.id || '', method, m.sessionId ? 'sid=' + m.sessionId.slice(0, 6) : '');
    if (method === 'Target.createTarget') {
      // 强制每个页落到独立窗口（MCP 默认建 tab，会与别的 session 挤在同一窗口，
      // 破坏 per-session 窗口/noVNC 隔离）。注入 newWindow + kiosk 尺寸。
      m.params = m.params || {};
      if (m.params.newWindow === undefined) m.params.newWindow = true;
      if (m.params.width === undefined) m.params.width = LOGICAL_W;
      if (m.params.height === undefined) m.params.height = LOGICAL_H;
      pendingCreate.add(m.id); lastCreateAt = Date.now(); rawUp(JSON.stringify(m)); return;
    }
    if (method === 'Target.getTargets') { pendingGetTargets.add(m.id); rawUp(JSON.stringify(m)); return; }
    // 跨 owner 的危险操作：仅当目标"已知属于别的 token"时拒绝
    // （未知 id —— 如 tab/基础设施 target —— 放行，避免破坏 puppeteer 内部机制）
    const tid = m.params && m.params.targetId;
    const guarded = ['Target.closeTarget', 'Target.attachToTarget', 'Target.activateTarget',
      'Target.getTargetInfo', 'Target.exposeDevToolsProtocol', 'Target.sendMessageToTarget'];
    if (tid && guarded.includes(method) && targetOwner.has(tid) && targetOwner.get(tid) !== token) {
      sendDown({ id: m.id, error: { code: -32000, message: `target ${tid} not owned by this session` } });
      return;
    }
    if (m.sessionId && hiddenSessions.has(m.sessionId)) {
      sendDown({ id: m.id, error: { code: -32000, message: 'session not visible' } });
      return;
    }
    const activeTarget = tid && targetOwner.get(tid) === token
      ? tid
      : (m.sessionId ? sessionState.cdpSessions.get(m.sessionId) : undefined);
    if (activeTarget) markAgentActive(token, activeTarget);
    rawUp(JSON.stringify(m));
  });

  // chrome -> agent
  up.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (DBG) log('C→A', m.id || '', m.method || (m.error ? 'ERR:' + m.error.message : 'result'),
      m.sessionId ? 'sid=' + m.sessionId.slice(0, 6) : '',
      (m.params && m.params.targetInfo) ? `t=${m.params.targetInfo.targetId.slice(0,6)}[${m.params.targetInfo.type}]` : '',
      (m.params && m.params.targetId) ? 'tid=' + m.params.targetId.slice(0, 6) : '',
      (m.result && m.result.targetId) ? 'newtid=' + m.result.targetId.slice(0, 6) : '');
    // 创建结果：认领归属并触发 provisioning
    if (m.id !== undefined && pendingCreate.has(m.id)) {
      pendingCreate.delete(m.id);
      if (m.result && m.result.targetId) {
        const t = m.result.targetId;
        targetOwner.set(t, token);
        ownedTargets.add(t);
        ensurePage(sessionState, t);
        flushOwned(t);                       // 放行此前缓冲的 targetCreated/attachedToTarget
        markAgentActive(token, t);
        provision(token, t).catch((e) => log('prov err', e.message));
      }
      sendDown(m);
      return;
    }
    // getTargets 结果：过滤为仅本 token 拥有的 target（堵住可见性泄露）
    if (m.id !== undefined && pendingGetTargets.has(m.id)) {
      pendingGetTargets.delete(m.id);
      if (m.result && Array.isArray(m.result.targetInfos)) {
        m.result.targetInfos = m.result.targetInfos.filter(
          (ti) => ownedTargets.has(ti.targetId) || targetOwner.get(ti.targetId) === token);
        for (const targetInfo of m.result.targetInfos) recordTargetInfo(token, targetInfo);
      }
      sendDown(m);
      return;
    }
    const method = m.method || '';
    // 隔离核心：
    //  - 'tab' 类型：只有"在我有未决 createTarget 时出现"的才是我的（myTabs），其余隐藏。
    //    隐藏 tab → puppeteer 不会驱动它 → 其内嵌 page 的 attach 根本不会产生 → 别人的页天然不可见。
    //  - 'page' 类型：按归属过滤（带竞态缓冲）。我的 page 只会出现在我的 tab 里。
    //  - 'browser' 等基础设施：透明放行。
    if (method === 'Target.targetCreated') {
      const ti = m.params.targetInfo; const t = ti.targetId;
      if (ti.type === 'tab') {
        if (midCreate()) { myTabs.add(t); sendDown(m); }              // 我正在创建 → 是我的 tab
        return;                                                       // 否则是别人的 tab → 隐藏
      }
      if (ti.type !== 'page') { sendDown(m); return; }
      if (ownedTargets.has(t) || targetOwner.get(t) === token) {
        ownedTargets.add(t); recordTargetInfo(token, ti); sendDown(m);
      }
      else if (targetOwner.has(t)) { /* 别人的 page → 丢 */ }
      else bufferEvent(t, m);
      return;
    }
    if (method === 'Target.targetInfoChanged') {
      const ti = m.params.targetInfo; const t = ti.targetId;
      if (ti.type === 'tab') { if (myTabs.has(t)) sendDown(m); return; }
      if (ti.type !== 'page') { sendDown(m); return; }
      if (ownedTargets.has(t)) { recordTargetInfo(token, ti); sendDown(m); }
      else if (pendingByTarget.has(t)) bufferEvent(t, m);
      return;
    }
    if (method === 'Target.attachedToTarget') {
      const ti = m.params.targetInfo; const t = ti.targetId; const sid = m.params.sessionId;
      if (ti.type === 'tab') {
        if (myTabs.has(t)) sendDown(m); else hiddenSessions.add(sid); // 别人的 tab → 隐藏其 session
        return;
      }
      if (ti.type !== 'page') { sendDown(m); return; }
      if (ownedTargets.has(t) || targetOwner.get(t) === token) {
        ownedTargets.add(t);
        sessionState.cdpSessions.set(sid, t);
        recordTargetInfo(token, ti);
        sendDown(m);
      }
      else if (targetOwner.has(t)) { hiddenSessions.add(sid); }
      else bufferEvent(t, m, sid);
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const sid = m.params.sessionId;
      if (hiddenSessions.has(sid)) { hiddenSessions.delete(sid); return; }
      sessionState.cdpSessions.delete(sid);
      sendDown(m); return;
    }
    if (method === 'Target.targetDestroyed') {
      const t = m.params.targetId;
      if (myTabs.has(t)) { myTabs.delete(t); sendDown(m); return; }
      if (targetOwner.has(t) && targetOwner.get(t) !== token) return; // 别人的 page → 丢
      if (targetOwner.has(t) || ownedTargets.has(t)) {
        ownedTargets.delete(t);
        removePage(token, t);
        sendDown(m);
        return;
      }
      return; // 别人的 tab/未知 → 已隐藏，丢弃其 destroy
    }
    if (m.sessionId && hiddenSessions.has(m.sessionId)) return; // 隐藏页的事件 → 丢
    sendDown(m);
  });

  const cleanup = () => { try { up.close(); } catch {}; };
  agentWs.on('close', () => {
    cleanup();
    const s = sessions.get(token);
    if (s) {
      s.connCount = Math.max(0, s.connCount - 1);
      if (s.connCount <= 0) scheduleTeardown(token);
    }
  });
  agentWs.on('error', cleanup);
  up.on('close', () => { try { agentWs.close(); } catch {} });
  up.on('error', (e) => { log('upstream err', e.message); try { agentWs.close(); } catch {} });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

function jsonResponse(res, statusCode, body) {
  setCors(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

// ---------------- HTTP + WS 服务 ----------------
const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  // 冒充 chrome：/s/<token>/json/version
  let m = u.pathname.match(/^\/s\/([^/]+)\/json\/version$/);
  if (m) {
    const token = m[1];
    const wsUrl = `ws://${req.headers.host}/s/${token}/devtools/browser/${crypto.randomBytes(8).toString('hex')}`;
    jsonResponse(res, 200, {
      Browser: 'Chrome/146.0.7680.177', 'Protocol-Version': '1.3',
      webSocketDebuggerUrl: wsUrl,
    });
    return;
  }
  // MCP wrapper binds its ephemeral transport token to a stable Botmux session id
  // before forwarding the first session-entry tool.
  m = u.pathname.match(/^\/s\/([^/]+)\/bind$/);
  if (m && req.method === 'PUT') {
    let body;
    try { body = await readJsonBody(req); } catch { jsonResponse(res, 400, { error: 'bad_json' }); return; }
    try {
      const sessionKey = bindTransport(m[1], body?.sessionId);
      jsonResponse(res, 200, { ok: true, sessionId: sessionKey });
    } catch (error) {
      jsonResponse(res, 400, { error: error.message });
    }
    return;
  }
  // 旁路：manifest
  m = u.pathname.match(/^\/s\/([^/]+)\/manifest$/);
  if (m) {
    const sessionKey = resolveSessionKey(m[1]);
    const mf = sessionKey ? manifestFor(sessionKey) : null;
    jsonResponse(res, mf ? 200 : 404, mf || { error: 'no such session' });
    return;
  }
  // 旁路：切换只读/可写  /s/<token>/viewonly?mode=follow|free&on=0|1
  m = u.pathname.match(/^\/s\/([^/]+)\/viewonly$/);
  if (m) {
    const sessionKey = resolveSessionKey(m[1]);
    const on = u.query.on !== '0';
    const mode = u.query.mode === 'free' ? 'free' : 'follow';
    const ok = setViewonly(sessionKey, on, mode);
    const s = sessions.get(sessionKey);
    const ready = ok && await waitForViewReady(s, mode);
    jsonResponse(res, ready ? 200 : (ok ? 503 : 404), { ok: ready, mode, viewonly: on });
    return;
  }
  m = u.pathname.match(/^\/s\/([^/]+)\/view-mode$/);
  if (m && req.method === 'PUT') {
    const sessionKey = resolveSessionKey(m[1]);
    let body;
    try { body = await readJsonBody(req); } catch { jsonResponse(res, 400, { error: 'bad_json' }); return; }
    const manifest = setViewMode(sessionKey, body?.mode);
    const s = sessions.get(sessionKey);
    const ready = manifest && (body?.mode !== 'free' || await waitForViewReady(s, 'free'));
    jsonResponse(res, ready ? 200 : (manifest ? 503 : 400), ready ? manifestFor(sessionKey) : { error: manifest ? 'view_not_ready' : 'invalid_session_or_mode' });
    return;
  }
  m = u.pathname.match(/^\/s\/([^/]+)\/free-target$/);
  if (m && req.method === 'PUT') {
    const sessionKey = resolveSessionKey(m[1]);
    let body;
    try { body = await readJsonBody(req); } catch { jsonResponse(res, 400, { error: 'bad_json' }); return; }
    const s = sessions.get(sessionKey);
    if (!s) { jsonResponse(res, 404, { error: 'no_such_session' }); return; }
    if (typeof body?.targetId !== 'string' || !selectFreeTarget(s, body.targetId)) {
      jsonResponse(res, 400, { error: 'invalid_or_unready_target' });
      return;
    }
    s.freeEnabled = true;
    touch(s);
    writeManifest(s.token);
    const ready = await waitForViewReady(s, 'free');
    jsonResponse(res, ready ? 200 : 503, ready ? manifestFor(s.token) : { error: 'view_not_ready' });
    return;
  }
  // 健康检查
  if (u.pathname === '/health') {
    jsonResponse(res, 200, {
      ok: true,
      pid: process.pid,
      serviceInstanceId: SERVICE_INSTANCE_ID,
      sessions: sessions.size,
      chromeBrowserWsUrl: Boolean(chromeBrowserWsUrl),
    });
    return;
  }
  // 总览
  if (u.pathname === '/sessions') {
    jsonResponse(res, 200, [...sessions.keys()].map(manifestFor));
    return;
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    const rows = [...sessions.keys()].map((t) => {
      const mf = manifestFor(t);
      return `<tr><td>${t.slice(0,12)}</td><td>${mf.botmuxSessionId||'-'}</td><td>${mf.pages.length}</td><td>${mf.mode}</td><td>${mf.novncUrl?`<a href="${mf.novncUrl}" target="_blank">Follow</a>`:'-'}</td><td>${mf.free?.novncUrl?`<a href="${mf.free.novncUrl}" target="_blank">Free</a>`:'-'}</td></tr>`;
    }).join('');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<html><head><meta charset=utf-8><title>Agent Chrome Sessions</title></head><body style="font-family:sans-serif">
      <h2>活跃会话 (${sessions.size})</h2>
      <table border=1 cellpadding=6><tr><th>token</th><th>Botmux Session</th><th>pages</th><th>mode</th><th>Follow</th><th>Free</th></tr>${rows}</table>
      </body></html>`);
    return;
  }
  res.statusCode = 404; res.end('not found');
});

const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const parsed = url.parse(req.url, true);
  const m = parsed.pathname.match(/^\/s\/([^/]+)\/devtools\//);
  if (!m) { socket.destroy(); return; }
  const transportToken = m[1];
  const botmuxSessionId = typeof parsed.query.botmuxSessionId === 'string' ? parsed.query.botmuxSessionId : undefined;
  let token;
  try {
    if (botmuxSessionId) {
      bindTransport(transportToken, botmuxSessionId);
      token = resolveSessionKey(transportToken);
    } else {
      token = resolveWebSocketSessionKey(transportToken);
    }
    if (!token) throw new Error('invalid_access_token');
  } catch {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    log('agent connected token=' + token.slice(0, 8));
    getSession(token, {
      accessToken: transportToken,
      botmuxSessionId: botmuxSessionId || (token !== transportToken ? token : undefined),
    });
    attachProxy(ws, token);
  });
});

(async () => {
  await ensureChrome();
  server.listen(CFG.brokerPort, () => log(`listening on :${CFG.brokerPort}  (host ${HOST})`));
})().catch((e) => { log('fatal', e); process.exit(1); });

process.on('SIGTERM', () => { for (const t of [...sessions.keys()]) teardown(t); process.exit(0); });
process.on('SIGINT', () => { for (const t of [...sessions.keys()]) teardown(t); process.exit(0); });
