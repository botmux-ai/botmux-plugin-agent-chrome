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
 *  3. 反应式分配：某 token 第一次创建窗口时，自动 kiosk 全屏、映射 X11 window-id、
 *     起该窗口专属的 x11vnc + noVNC、落 manifest。
 *  4. 旁路 HTTP：/s/<token>/manifest、/sessions、/ 提供环境信息与观看入口。
 */
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const WebSocket = require('ws');
const { CDP, httpGetJson } = require('../lib/cdp');

const CFG = {
  display: process.env.ACS_DISPLAY || ':77',
  chromePort: parseInt(process.env.ACS_CHROME_PORT || '9223', 10),
  brokerPort: parseInt(process.env.ACS_BROKER_PORT || '9300', 10),
  vncBase: parseInt(process.env.ACS_VNC_BASE || '5910', 10),
  novncBase: parseInt(process.env.ACS_NOVNC_BASE || '6090', 10),
  novncWeb: process.env.ACS_NOVNC_WEB || '/usr/share/novnc',
  manifests: process.env.ACS_MANIFESTS || '/data00/home/wanghao.muchen/agent-chrome/run/manifests',
  logs: process.env.ACS_LOGS || '/data00/home/wanghao.muchen/agent-chrome/logs',
};

function log(...a) { console.log(new Date().toISOString(), '[broker]', ...a); }
function xdo(cmd) { return execSync(`DISPLAY=${CFG.display} ${cmd}`, { encoding: 'utf8' }).trim(); }
function hostHint() {
  try { return execSync("hostname -I", { encoding: 'utf8' }).trim().split(/\s+/)[0] || '127.0.0.1'; }
  catch { return '127.0.0.1'; }
}
const HOST = hostHint();

let chromeBrowserWsUrl = null;       // 真 Chrome 的 browser ws
let control = null;                  // broker 自用控制连接（provisioning）
const targetOwner = new Map();       // targetId -> token（全局归属表）
const sessions = new Map();          // token -> session 状态
let portCursor = 0;                  // 端口分配游标
const mappedWindows = new Set();     // 已分配的 X11 window-id（全局，供"新窗口差集"映射）
let provChain = Promise.resolve();   // provisioning 串行化队列（避免并发映射歧义）

async function ensureChrome() {
  const v = await httpGetJson(`http://127.0.0.1:${CFG.chromePort}/json/version`);
  chromeBrowserWsUrl = v.webSocketDebuggerUrl;
  control = await CDP.connectBrowser(`http://127.0.0.1:${CFG.chromePort}`);
  log('connected control to real chrome', chromeBrowserWsUrl);
  // chrome 挂了（OOM/重启）→ 控制连接断 → 退出，交给 systemd 重启本进程，
  // 其 ExecStartPre 会等 chrome 回来后重连，实现自愈。
  control.ws.on('close', () => { log('control connection to chrome lost → exiting for restart'); process.exit(1); });
  control.ws.on('error', () => { log('control connection error → exiting for restart'); process.exit(1); });
}

function getSession(token) {
  let s = sessions.get(token);
  if (!s) {
    s = { token, windows: new Map(), vnc: null, viewonly: true, createdAt: Date.now(), connCount: 0 };
    sessions.set(token, s);
  }
  return s;
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
  let cdpWindowId;
  try { ({ windowId: cdpWindowId } = await control.send('Browser.getWindowForTarget', { targetId })); }
  catch (e) { log('getWindowForTarget warn', e.message); return; }

  const winId = await mapWindow(cdpWindowId);
  if (!winId) { log('WARN: X11 window-id not found for', targetId.slice(0, 8)); return; }
  if (!sessions.has(token)) return;
  mappedWindows.add(winId);
  if (s.windows.has(winId)) return;
  s.windows.set(winId, { targetId, winId });

  if (!s.vnc) {
    const vncPort = CFG.vncBase + portCursor;
    const novncPort = CFG.novncBase + portCursor;
    portCursor++;
    startVnc(s, winId, vncPort, novncPort);
  }
  writeManifest(token);
  log(`provisioned token=${token.slice(0,8)} target=${targetId.slice(0,8)} win=${winId}`);
}

function startVnc(s, winId, vncPort, novncPort) {
  const vncArgs = ['-id', winId, '-display', CFG.display, '-rfbport', String(vncPort),
    '-localhost', '-forever', '-shared', '-nopw', '-noxdamage', '-quiet'];
  if (s.viewonly) vncArgs.push('-viewonly');
  const vnc = spawn('x11vnc', vncArgs, { stdio: ['ignore',
    fs.openSync(`${CFG.logs}/x11vnc-${vncPort}.log`, 'a'),
    fs.openSync(`${CFG.logs}/x11vnc-${vncPort}.log`, 'a')] });
  const nov = spawn('websockify', ['--web=' + CFG.novncWeb, `0.0.0.0:${novncPort}`, `localhost:${vncPort}`],
    { stdio: ['ignore', fs.openSync(`${CFG.logs}/novnc-${novncPort}.log`, 'a'),
      fs.openSync(`${CFG.logs}/novnc-${novncPort}.log`, 'a')] });
  s.vnc = { winId, vncPort, novncPort, vncPid: vnc.pid, novncPid: nov.pid, vncProc: vnc, novncProc: nov };
  s.novncUrl = `http://${HOST}:${novncPort}/vnc.html?autoconnect=true&resize=scale&path=websockify`;
  log(`vnc up token=${s.token.slice(0,8)} win=${winId} vnc=${vncPort} novnc=${novncPort} viewonly=${s.viewonly}`);
}

// 切换只读/可写：重启 x11vnc（agent 可调）
function setViewonly(token, viewonly) {
  const s = sessions.get(token);
  if (!s || !s.vnc) return false;
  s.viewonly = viewonly;
  const { winId, vncPort, novncPort, vncProc } = s.vnc;
  try { vncProc.kill('SIGTERM'); } catch {}
  // novnc 保留，只重启 x11vnc
  const vncArgs = ['-id', winId, '-display', CFG.display, '-rfbport', String(vncPort),
    '-localhost', '-forever', '-shared', '-nopw', '-noxdamage', '-quiet'];
  if (viewonly) vncArgs.push('-viewonly');
  setTimeout(() => {
    const vnc = spawn('x11vnc', vncArgs, { stdio: ['ignore',
      fs.openSync(`${CFG.logs}/x11vnc-${vncPort}.log`, 'a'),
      fs.openSync(`${CFG.logs}/x11vnc-${vncPort}.log`, 'a')] });
    s.vnc.vncPid = vnc.pid; s.vnc.vncProc = vnc;
    writeManifest(token);
  }, 300);
  return true;
}

function manifestFor(token) {
  const s = sessions.get(token);
  if (!s) return null;
  const primary = s.vnc;
  return {
    token,
    DISPLAY: CFG.display,
    geometry: `${process.env.ACS_LOGICAL_W || 1728}x${process.env.ACS_LOGICAL_H || 1117}@${process.env.ACS_DPR || 2}x`,
    windowIds: [...s.windows.keys()],
    primaryWindowId: primary ? primary.winId : null,
    vncPort: primary ? primary.vncPort : null,
    novncPort: primary ? primary.novncPort : null,
    novncUrl: s.novncUrl || null,
    viewonly: s.viewonly,
    targets: [...s.windows.values()].map((w) => w.targetId),
    updatedAt: Date.now(),
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
  if (s.vnc) {
    try { s.vnc.vncProc.kill('SIGTERM'); } catch {}
    try { s.vnc.novncProc.kill('SIGTERM'); } catch {}
  }
  // 关掉该 token 的所有窗口/target
  for (const w of s.windows.values()) {
    control.send('Target.closeTarget', { targetId: w.targetId }).catch(() => {});
    targetOwner.delete(w.targetId);
    mappedWindows.delete(w.winId);
  }
  try { fs.unlinkSync(path.join(CFG.manifests, token + '.json')); } catch {}
  sessions.delete(token);
  log('teardown token=' + token.slice(0, 8));
}

// ---- 每条 agent 连接的 CDP 过滤代理 ----
function attachProxy(agentWs, token) {
  // 连接引用计数：同一 token 可有多条连接（holder + 偶发探测）；
  // 只有最后一条连接关闭才 teardown —— 避免一个瞬时连接拆掉整个会话。
  getSession(token).connCount++;
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
  function flushOwned(t) {                   // 该 target 被本连接认领 → 缓冲事件作为"自己的"放行
    const e = pendingByTarget.get(t); if (!e) return;
    clearTimeout(e.timer); pendingByTarget.delete(t);
    for (const msg of e.msgs) sendDown(msg);
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
        flushOwned(t);                       // 放行此前缓冲的 targetCreated/attachedToTarget
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
      if (ownedTargets.has(t) || targetOwner.get(t) === token) { ownedTargets.add(t); sendDown(m); }
      else if (targetOwner.has(t)) { /* 别人的 page → 丢 */ }
      else bufferEvent(t, m);
      return;
    }
    if (method === 'Target.targetInfoChanged') {
      const ti = m.params.targetInfo; const t = ti.targetId;
      if (ti.type === 'tab') { if (myTabs.has(t)) sendDown(m); return; }
      if (ti.type !== 'page') { sendDown(m); return; }
      if (ownedTargets.has(t)) sendDown(m);
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
      if (ownedTargets.has(t) || targetOwner.get(t) === token) { ownedTargets.add(t); sendDown(m); }
      else if (targetOwner.has(t)) { hiddenSessions.add(sid); }
      else bufferEvent(t, m, sid);
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const sid = m.params.sessionId;
      if (hiddenSessions.has(sid)) { hiddenSessions.delete(sid); return; }
      sendDown(m); return;
    }
    if (method === 'Target.targetDestroyed') {
      const t = m.params.targetId;
      if (myTabs.has(t)) { myTabs.delete(t); sendDown(m); return; }
      if (targetOwner.has(t) && targetOwner.get(t) !== token) return; // 别人的 page → 丢
      if (targetOwner.has(t) || ownedTargets.has(t)) { ownedTargets.delete(t); targetOwner.delete(t); sendDown(m); return; }
      return; // 别人的 tab/未知 → 已隐藏，丢弃其 destroy
    }
    if (m.sessionId && hiddenSessions.has(m.sessionId)) return; // 隐藏页的事件 → 丢
    sendDown(m);
  });

  const cleanup = () => { try { up.close(); } catch {}; };
  agentWs.on('close', () => {
    cleanup();
    const s = sessions.get(token);
    if (s) { s.connCount--; if (s.connCount <= 0) teardown(token); }  // 仅最后一条连接关闭才拆台
  });
  agentWs.on('error', cleanup);
  up.on('close', () => { try { agentWs.close(); } catch {} });
  up.on('error', (e) => { log('upstream err', e.message); try { agentWs.close(); } catch {} });
}

// ---------------- HTTP + WS 服务 ----------------
const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  // 冒充 chrome：/s/<token>/json/version
  let m = u.pathname.match(/^\/s\/([^/]+)\/json\/version$/);
  if (m) {
    const token = m[1];
    const wsUrl = `ws://${req.headers.host}/s/${token}/devtools/browser/${crypto.randomBytes(8).toString('hex')}`;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      Browser: 'Chrome/146.0.7680.177', 'Protocol-Version': '1.3',
      webSocketDebuggerUrl: wsUrl,
    }));
    return;
  }
  // 旁路：manifest
  m = u.pathname.match(/^\/s\/([^/]+)\/manifest$/);
  if (m) {
    const mf = manifestFor(m[1]);
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = mf ? 200 : 404;
    res.end(JSON.stringify(mf || { error: 'no such session' }));
    return;
  }
  // 旁路：切换只读/可写  /s/<token>/viewonly?on=0|1
  m = u.pathname.match(/^\/s\/([^/]+)\/viewonly$/);
  if (m) {
    const on = u.query.on !== '0';
    const ok = setViewonly(m[1], on);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok, viewonly: on }));
    return;
  }
  // 健康检查
  if (u.pathname === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      pid: process.pid,
      sessions: sessions.size,
      chromeBrowserWsUrl: Boolean(chromeBrowserWsUrl),
    }));
    return;
  }
  // 总览
  if (u.pathname === '/sessions') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([...sessions.keys()].map(manifestFor), null, 2));
    return;
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    const rows = [...sessions.keys()].map((t) => {
      const mf = manifestFor(t);
      return `<tr><td>${t.slice(0,12)}</td><td>${mf.primaryWindowId||'-'}</td><td>${mf.viewonly?'只读':'可写'}</td><td>${mf.novncUrl?`<a href="${mf.novncUrl}" target="_blank">打开</a>`:'-'}</td></tr>`;
    }).join('');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<html><head><meta charset=utf-8><title>Agent Chrome Sessions</title></head><body style="font-family:sans-serif">
      <h2>活跃会话 (${sessions.size})</h2>
      <table border=1 cellpadding=6><tr><th>token</th><th>window</th><th>模式</th><th>noVNC</th></tr>${rows}</table>
      </body></html>`);
    return;
  }
  res.statusCode = 404; res.end('not found');
});

const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const m = url.parse(req.url).pathname.match(/^\/s\/([^/]+)\/devtools\//);
  if (!m) { socket.destroy(); return; }
  const token = m[1];
  wss.handleUpgrade(req, socket, head, (ws) => {
    log('agent connected token=' + token.slice(0, 8));
    attachProxy(ws, token);
  });
});

(async () => {
  await ensureChrome();
  server.listen(CFG.brokerPort, () => log(`listening on :${CFG.brokerPort}  (host ${HOST})`));
})().catch((e) => { log('fatal', e); process.exit(1); });

process.on('SIGTERM', () => { for (const t of [...sessions.keys()]) teardown(t); process.exit(0); });
process.on('SIGINT', () => { for (const t of [...sessions.keys()]) teardown(t); process.exit(0); });
