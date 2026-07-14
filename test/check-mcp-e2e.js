'use strict';
// End to end: start mcp-launch.sh exactly as a CLI does, then drive the real
// chrome-devtools-mcp through initialize -> bind -> new_page -> list_pages.
const { spawn, execSync } = require('node:child_process');
const path = require('node:path');

const WRAPPER = path.join(__dirname, '..', 'dist', 'bin', 'mcp-launch.sh');
const FIXED_TOKEN = `e2e${Date.now()}`;
const BOTMUX_SESSION_ID = `botmux-mcp-e2e-${Date.now()}`;
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

let buffer = '';
const waiters = [];
child.stdout.on('data', chunk => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (!waiters[index].match(message)) continue;
      waiters[index].resolve(message);
      waiters.splice(index, 1);
    }
  }
});
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });

let id = 0;
function rpc(method, params) {
  const requestId = ++id;
  const response = new Promise(resolve => waiters.push({ match: message => message.id === requestId, resolve }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  return response;
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}
function text(result) {
  return (result.result?.content || []).map(content => content.text || '').join('\n');
}

(async () => {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '1' },
  });
  notify('notifications/initialized', {});

  const listedTools = await rpc('tools/list', {});
  const tools = new Map((listedTools.result?.tools || []).map(tool => [tool.name, tool]));
  const requiredSessionTools = [
    'list_pages',
    'new_page',
    'browser_session_info',
    'browser_session_set_writable',
  ];
  const removedSessionTools = [
    'browser_session_get_vnc_url',
    'browser_session_screenshot',
    'browser_session_activate',
    'browser_session_send_keys',
    'browser_session_click',
  ];
  const toolsMerged = requiredSessionTools.every(name => tools.has(name))
    && requiredSessionTools.every(name => tools.get(name).inputSchema?.required?.includes('sessionId'))
    && removedSessionTools.every(name => !tools.has(name));
  console.log('composite tools and session schemas:', toolsMerged);

  const unbound = await rpc('tools/call', { name: 'take_snapshot', arguments: {} });
  const unboundRejected = unbound.result?.isError === true && /list_pages or new_page/.test(text(unbound));
  console.log('unbound non-entry rejected:', unboundRejected);

  const newPage = await rpc('tools/call', {
    name: 'new_page',
    arguments: { sessionId: BOTMUX_SESSION_ID, url: 'about:blank' },
  });
  const newPageOk = /about:blank/.test(text(newPage));
  console.log('new_page ok:', newPageOk);

  const listPages = await rpc('tools/call', {
    name: 'list_pages',
    arguments: { sessionId: BOTMUX_SESSION_ID },
  });
  const pageListed = /about:blank/.test(text(listPages));
  console.log('list_pages includes page:', pageListed);

  let manifest = {};
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      manifest = JSON.parse(execSync(`curl -fsS ${BROKER}/s/${FIXED_TOKEN}/manifest`, { encoding: 'utf8' }));
      if (manifest.primaryWindowId && manifest.novncUrl) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  console.log('manifest novncUrl:', manifest.novncUrl || '(none)');
  const sessionLinked = manifest.token === FIXED_TOKEN
    && manifest.botmuxSessionId === BOTMUX_SESSION_ID
    && manifest.pages?.length === 1;
  console.log('stable botmux session linked:', sessionLinked);

  const sessionInfo = await rpc('tools/call', {
    name: 'browser_session_info',
    arguments: { sessionId: BOTMUX_SESSION_ID },
  });
  const infoText = text(sessionInfo);
  const infoOk = /primaryWindowId/.test(infoText)
    && /vnc\.html/.test(infoText)
    && !infoText.includes(FIXED_TOKEN);
  console.log('session info sanitized with VNC:', infoOk);

  const freeResponse = await fetch(`${BROKER}/s/${FIXED_TOKEN}/view-mode`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'free' }),
  });
  const freeManifest = await freeResponse.json();
  for (let attempt = 0; attempt < 40 && !freeManifest.free?.novncUrl; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      Object.assign(freeManifest, JSON.parse(execSync(`curl -fsS ${BROKER}/s/${FIXED_TOKEN}/manifest`, { encoding: 'utf8' })));
    } catch {}
  }
  const freeVncOk = freeResponse.ok && freeManifest.free?.enabled === true && /vnc\.html/.test(freeManifest.free?.novncUrl || '');
  console.log('session free VNC:', freeVncOk);

  const writable = await rpc('tools/call', {
    name: 'browser_session_set_writable',
    arguments: { sessionId: BOTMUX_SESSION_ID, writable: true },
  });
  const readonly = await rpc('tools/call', {
    name: 'browser_session_set_writable',
    arguments: { sessionId: BOTMUX_SESSION_ID, writable: false },
  });
  const freeWritable = await rpc('tools/call', {
    name: 'browser_session_set_writable',
    arguments: { sessionId: BOTMUX_SESSION_ID, mode: 'free', writable: true },
  });
  const writableOk = /enabled/.test(text(writable))
    && /view-only/.test(text(readonly))
    && /enabled/.test(text(freeWritable));
  console.log('session writable toggle:', writableOk);

  const mismatched = await rpc('tools/call', {
    name: 'list_pages',
    arguments: { sessionId: 'another-session' },
  });
  const mismatchRejected = mismatched.result?.isError === true && /does not match/.test(text(mismatched));
  console.log('mismatched session rejected:', mismatchRejected);

  const pass = toolsMerged && unboundRejected && newPageOk && pageListed
    && manifest.novncUrl && sessionLinked && infoOk && freeVncOk && writableOk && mismatchRejected;
  console.log(pass ? 'PASS: real MCP chain uses stable Botmux session context' : 'FAIL');

  child.kill('SIGTERM');
  setTimeout(() => process.exit(pass ? 0 : 1), 500);
})().catch(error => {
  console.error('ERR', error, `\nSTDERR: ${stderr.slice(-500)}`);
  child.kill();
  process.exit(1);
});
