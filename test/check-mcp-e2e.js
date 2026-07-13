'use strict';
// 端到端：像 CLI 那样把 mcp-launch.sh 当 MCP 的启动命令拉起，走真正的
// chrome-devtools-mcp，用最小 MCP(JSON-RPC over stdio) 客户端驱动它：
// initialize → new_page → list_pages，验证整条 CLI→wrapper→MCP→broker→chrome 链路。
const { spawn, execSync } = require('child_process');
const { existsSync, rmSync } = require('fs');
const path = require('path');

const WRAPPER = path.join(__dirname, '..', 'dist', 'bin', 'mcp-launch.sh');
const FIXED_TOKEN = 'e2e' + Date.now();
const BOTMUX_SESSION_ID = 'botmux-mcp-e2e-' + Date.now();
const BROKER_PORT = process.env.ACS_BROKER_PORT || 9300;
const BROKER = `http://127.0.0.1:${BROKER_PORT}`;

const child = spawn('bash', [WRAPPER], {
  env: {
    ...process.env,
    ACS_SESSION_TOKEN: FIXED_TOKEN,
    BOTMUX_SESSION_ID,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const waiters = [];
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    for (let k = waiters.length - 1; k >= 0; k--) {
      if (waiters[k].match(msg)) { waiters[k].resolve(msg); waiters.splice(k, 1); }
    }
  }
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

let id = 0;
function rpc(method, params) {
  const myId = ++id;
  const p = new Promise((resolve) => waiters.push({ match: (m) => m.id === myId, resolve }));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  return p;
}
function notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
const txt = (r) => (r.result && r.result.content || []).map((c) => c.text || '').join('\n');

(async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  notify('notifications/initialized', {});

  const tools = await rpc('tools/list', {});
  const toolNames = new Set((tools.result?.tools || []).map(tool => tool.name));
  const requiredSessionTools = [
    'browser_session_info',
    'browser_session_get_vnc_url',
    'browser_session_set_writable',
    'browser_session_screenshot',
    'browser_session_activate',
  ];
  const toolsMerged = toolNames.has('new_page') && requiredSessionTools.every(name => toolNames.has(name));
  console.log('composite tools merged:', toolsMerged);

  // 新开一个页
  const np = await rpc('tools/call', { name: 'new_page', arguments: { url: 'about:blank' } });
  const newPageOk = /about:blank/.test(txt(np));
  console.log('new_page ok:', newPageOk);

  // 列出页面（应只有本 session 的）
  const lp = await rpc('tools/call', { name: 'list_pages', arguments: {} });
  const listed = txt(lp);
  const pageListed = /about:blank/.test(listed);
  console.log('list_pages includes page:', pageListed);

  // broker 侧应看到本 token 的连接 + manifest
  let mf = {};
  for (let i=0;i<60;i++){ try { mf = JSON.parse(execSync(`curl -fsS ${BROKER}/s/${FIXED_TOKEN}/manifest`, {encoding:'utf8'})); if (mf.primaryWindowId && mf.novncUrl) break; } catch {} await new Promise(r=>setTimeout(r,150)); }
  console.log('manifest novncUrl:', mf.novncUrl || '(none)');
  const sessionLinked = mf.botmuxSessionId === BOTMUX_SESSION_ID && mf.pages?.length === 1;
  console.log('botmux session linked:', sessionLinked);

  const sessionInfo = await rpc('tools/call', { name: 'browser_session_info', arguments: {} });
  const infoText = txt(sessionInfo);
  const infoOk = /primaryWindowId/.test(infoText) && !infoText.includes(FIXED_TOKEN);
  console.log('session info sanitized:', infoOk);

  const vnc = await rpc('tools/call', { name: 'browser_session_get_vnc_url', arguments: {} });
  const vncOk = /vnc\.html/.test(txt(vnc));
  console.log('session vnc:', vncOk);

  const freeResponse = await fetch(`${BROKER}/s/${FIXED_TOKEN}/view-mode`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'free' }),
  });
  const freeManifest = await freeResponse.json();
  for (let i = 0; i < 40 && !freeManifest.free?.novncUrl; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      const latest = JSON.parse(execSync(`curl -fsS ${BROKER}/s/${FIXED_TOKEN}/manifest`, { encoding: 'utf8' }));
      Object.assign(freeManifest, latest);
    } catch {}
  }
  const freeVnc = await rpc('tools/call', { name: 'browser_session_get_vnc_url', arguments: { mode: 'free' } });
  const freeVncOk = freeResponse.ok && freeManifest.free?.enabled === true && /vnc\.html/.test(txt(freeVnc));
  console.log('session free vnc:', freeVncOk);

  const writable = await rpc('tools/call', { name: 'browser_session_set_writable', arguments: { writable: true } });
  const readonly = await rpc('tools/call', { name: 'browser_session_set_writable', arguments: { writable: false } });
  const freeWritable = await rpc('tools/call', { name: 'browser_session_set_writable', arguments: { mode: 'free', writable: true } });
  const writableOk = /enabled/.test(txt(writable)) && /view-only/.test(txt(readonly)) && /enabled/.test(txt(freeWritable));
  console.log('session writable toggle:', writableOk);

  const shot = path.join('/tmp', `agent-chrome-mcp-${FIXED_TOKEN}.png`);
  const screenshot = await rpc('tools/call', { name: 'browser_session_screenshot', arguments: { filePath: shot } });
  const screenshotOk = existsSync(shot) && /Saved native browser window screenshot/.test(txt(screenshot));
  console.log('session native screenshot:', screenshotOk);
  rmSync(shot, { force: true });

  const activated = await rpc('tools/call', { name: 'browser_session_activate', arguments: {} });
  const keys = await rpc('tools/call', { name: 'browser_session_send_keys', arguments: { keys: ['Escape'] } });
  const click = await rpc('tools/call', { name: 'browser_session_click', arguments: { x: 10, y: 10 } });
  const nativeInputOk = /Activated/.test(txt(activated))
    && /Sent 1 key/.test(txt(keys))
    && /Clicked/.test(txt(click));
  console.log('session bounded native input:', nativeInputOk);

  const unsafeKeys = await rpc('tools/call', { name: 'browser_session_send_keys', arguments: { keys: ['--window', '1'] } });
  const outsideClick = await rpc('tools/call', { name: 'browser_session_click', arguments: { x: 999999, y: 999999 } });
  const nativeInputBounded = unsafeKeys.result?.isError === true && outsideClick.result?.isError === true;
  console.log('session native input rejects escape attempts:', nativeInputBounded);

  const pass = toolsMerged && newPageOk && pageListed && mf.novncUrl && sessionLinked
    && infoOk && vncOk && freeVncOk && writableOk && screenshotOk && nativeInputOk && nativeInputBounded;
  console.log(pass ? 'PASS: 端到端（真实 MCP）链路打通且被管理' : 'FAIL');

  child.kill('SIGTERM');
  setTimeout(() => process.exit(pass ? 0 : 1), 500);
})().catch((e) => { console.error('ERR', e, '\nSTDERR:', stderr.slice(-500)); child.kill(); process.exit(1); });
