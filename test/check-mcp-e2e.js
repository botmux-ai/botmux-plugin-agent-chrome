'use strict';
// 端到端：像 CLI 那样把 mcp-launch.sh 当 MCP 的启动命令拉起，走真正的
// chrome-devtools-mcp，用最小 MCP(JSON-RPC over stdio) 客户端驱动它：
// initialize → new_page → list_pages，验证整条 CLI→wrapper→MCP→broker→chrome 链路。
const { spawn, execSync } = require('child_process');
const path = require('path');

const WRAPPER = path.join(__dirname, '..', 'bin', 'mcp-launch.sh');
const FIXED_TOKEN = 'e2e' + Date.now();

const child = spawn('bash', [WRAPPER], {
  env: { ...process.env, ACS_SESSION_TOKEN: FIXED_TOKEN },
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

  // 新开一个页
  const np = await rpc('tools/call', { name: 'new_page', arguments: { url: 'https://example.com/' } });
  console.log('new_page ok:', /example\.com|Example/.test(txt(np)) || txt(np).slice(0, 60));

  // 列出页面（应只有本 session 的）
  const lp = await rpc('tools/call', { name: 'list_pages', arguments: {} });
  const listed = txt(lp);
  const exampleCount = (listed.match(/example\.com/g) || []).length;
  console.log('list_pages 提到 example.com 次数:', exampleCount);

  // broker 侧应看到本 token 的连接 + manifest
  let mf = {};
  for (let i=0;i<60;i++){ try { mf = JSON.parse(execSync(`curl -fsS http://127.0.0.1:9300/s/${FIXED_TOKEN}/manifest`, {encoding:'utf8'})); if (mf.primaryWindowId) break; } catch {} await new Promise(r=>setTimeout(r,150)); }
  console.log('manifest novncUrl:', mf.novncUrl || '(none)');

  // browser-session helper 能否用同 token 取到信息
  let helperOk = false;
  try {
    const info = execSync(`ACS_SESSION_TOKEN=${FIXED_TOKEN} ${path.join(__dirname, '..', 'bin', 'browser-session')} vnc`, { encoding: 'utf8' }).trim();
    helperOk = /vnc.html/.test(info);
    console.log('browser-session vnc:', info);
  } catch (e) { console.log('helper err', e.message); }

  const pass = /example/i.test(listed) && mf.novncUrl && helperOk;
  console.log(pass ? 'PASS: 端到端（真实 MCP）链路打通且被管理' : 'FAIL');

  child.kill('SIGTERM');
  setTimeout(() => process.exit(pass ? 0 : 1), 500);
})().catch((e) => { console.error('ERR', e, '\nSTDERR:', stderr.slice(-500)); child.kill(); process.exit(1); });
