'use strict';

const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'agent-chrome-context-'));
const fakeMcp = join(temp, 'fake-mcp.js');
const stableSessionId = 'botmux-session-context-test';
const bindings = new Map();

writeFileSync(fakeMcp, `
'use strict';
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-chrome-context-test', version: '1.0.0' },
      },
    });
    return;
  }
  if (request.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [
          { name: 'list_pages', description: 'list', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
          { name: 'new_page', description: 'new', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
          { name: 'click', description: 'click', inputSchema: { type: 'object', properties: { uid: { type: 'string' } }, required: ['uid'], additionalProperties: false } },
        ],
      },
    });
    return;
  }
  if (request.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ name: request.params.name, arguments: request.params.arguments || {} }) }],
      },
    });
  }
});
`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try { resolvePromise(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

function forwarded(result) {
  return JSON.parse(result.result.content[0].text);
}

function resultText(result) {
  return (result.result?.content || []).map(item => item.text || '').join('\n');
}

function startClient(port, transportToken) {
  const child = spawn(join(root, 'dist', 'bin', 'mcp-launch.sh'), [], {
    cwd: root,
    env: {
      ...process.env,
      ACS_NODE_BIN: process.execPath,
      ACS_MCP_BIN: fakeMcp,
      ACS_BROKER_PORT: String(port),
      ACS_SESSION_TOKEN: transportToken,
      BOTMUX_SESSION_ID: stableSessionId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 0;
  let stdout = '';
  let stderr = '';
  const pending = new Map();

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  child.on('exit', code => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP wrapper exited with ${code}: ${stderr}`));
    }
    pending.clear();
  });

  function rpc(method, params) {
    const id = ++nextId;
    const response = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}; stderr=${stderr}`));
      }, 5_000);
      pending.set(id, { resolve: resolvePromise, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  }

  async function stop() {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise(resolvePromise => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolvePromise();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }

  return { rpc, stop };
}

async function exerciseClient(port, transportToken) {
  const client = startClient(port, transportToken);
  try {
    await client.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'agent-chrome-context-test', version: '1.0.0' },
    });

    const listed = await client.rpc('tools/list', {});
    const tools = new Map(listed.result.tools.map(tool => [tool.name, tool]));
    for (const name of ['list_pages', 'new_page', 'browser_session_info', 'browser_session_set_writable']) {
      assert(tools.get(name)?.inputSchema?.required?.includes('sessionId'), `${name} must require sessionId`);
    }
    assert(!tools.get('click')?.inputSchema?.properties?.sessionId, 'non-entry Chrome tools must not expose sessionId');
    for (const name of [
      'browser_session_get_vnc_url',
      'browser_session_screenshot',
      'browser_session_activate',
      'browser_session_send_keys',
      'browser_session_click',
    ]) {
      assert(!tools.has(name), `${name} should not be exposed`);
    }
    assert(!bindings.has(transportToken), 'initialize and tools/list must not bind the transport');

    const directClick = await client.rpc('tools/call', { name: 'click', arguments: { uid: 'node-1' } });
    assert(directClick.result?.isError === true && /list_pages or new_page/.test(resultText(directClick)), 'unbound non-entry tool must fail safely');
    assert(!bindings.has(transportToken), 'rejected non-entry tool must not bind the transport');

    const missingSession = await client.rpc('tools/call', { name: 'list_pages', arguments: {} });
    assert(missingSession.result?.isError === true, 'entry tool must reject a missing sessionId');
    assert(!bindings.has(transportToken), 'entry tool without sessionId must not bind the transport');

    const wrongSession = await client.rpc('tools/call', {
      name: 'list_pages',
      arguments: { sessionId: 'another-session' },
    });
    assert(wrongSession.result?.isError === true && /does not match/.test(resultText(wrongSession)), 'trusted Botmux session mismatch must be rejected');
    assert(!bindings.has(transportToken), 'mismatched sessionId must not bind the transport');

    const newPage = await client.rpc('tools/call', {
      name: 'new_page',
      arguments: { sessionId: stableSessionId, url: 'about:blank' },
    });
    assert(bindings.get(transportToken) === stableSessionId, 'first valid entry tool must bind the transport');
    assert(forwarded(newPage).arguments.url === 'about:blank', 'new_page must preserve upstream arguments');
    assert(forwarded(newPage).arguments.sessionId === undefined, 'new_page must strip sessionId before forwarding');

    const listPages = await client.rpc('tools/call', {
      name: 'list_pages',
      arguments: { sessionId: stableSessionId },
    });
    assert(bindings.get(transportToken) === stableSessionId, 'subsequent entry tool must reuse the stable session binding');
    assert(Object.keys(forwarded(listPages).arguments).length === 0, 'sessionId must not be forwarded downstream');

    const click = await client.rpc('tools/call', { name: 'click', arguments: { uid: 'node-1' } });
    assert(forwarded(click).arguments.uid === 'node-1', 'bound non-entry tool must pass through unchanged');

    const info = await client.rpc('tools/call', {
      name: 'browser_session_info',
      arguments: { sessionId: stableSessionId },
    });
    assert(info.result?.structuredContent?.botmuxSessionId === stableSessionId, 'session info must resolve the stable session');
    assert(info.result?.structuredContent?.follow?.novncUrl === 'http://10.0.0.1:6090/vnc.html', 'session info must include the noVNC URL');
    assert(!Object.hasOwn(info.result?.structuredContent || {}, 'token'), 'session info must not expose the transport token');

    const writable = await client.rpc('tools/call', {
      name: 'browser_session_set_writable',
      arguments: { sessionId: stableSessionId, writable: true },
    });
    assert(writable.result?.structuredContent?.writable === true, 'writable control must use the stable session binding');
  } finally {
    await client.stop();
  }
}

async function main() {
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    const bindMatch = requestUrl.pathname.match(/^\/s\/([^/]+)\/bind$/);
    if (request.method === 'PUT' && bindMatch) {
      const body = await readBody(request);
      const transportToken = decodeURIComponent(bindMatch[1]);
      const existing = bindings.get(transportToken);
      if (existing && existing !== body.sessionId) {
        sendJson(response, 400, { error: 'transport_already_bound' });
        return;
      }
      bindings.set(transportToken, body.sessionId);
      sendJson(response, 200, { ok: true, sessionId: body.sessionId });
      return;
    }

    const manifestMatch = requestUrl.pathname.match(/^\/s\/([^/]+)\/manifest$/);
    if (manifestMatch) {
      const transportToken = decodeURIComponent(manifestMatch[1]);
      const sessionId = bindings.get(transportToken);
      if (!sessionId) {
        sendJson(response, 404, { error: 'no such session' });
        return;
      }
      sendJson(response, 200, {
        token: transportToken,
        botmuxSessionId: sessionId,
        DISPLAY: ':77',
        pages: [],
        mode: 'follow',
        follow: { novncUrl: 'http://10.0.0.1:6090/vnc.html', viewonly: true },
        free: { enabled: false },
      });
      return;
    }

    const writableMatch = requestUrl.pathname.match(/^\/s\/([^/]+)\/viewonly$/);
    if (writableMatch) {
      const transportToken = decodeURIComponent(writableMatch[1]);
      if (!bindings.has(transportToken)) {
        sendJson(response, 404, { error: 'no such session' });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        mode: requestUrl.searchParams.get('mode') || 'follow',
        viewonly: requestUrl.searchParams.get('on') !== '0',
      });
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const { port } = server.address();

  try {
    await exerciseClient(port, 'transport-a');
    await exerciseClient(port, 'transport-b');
    assert(bindings.get('transport-a') === stableSessionId, 'first transport binding was lost');
    assert(bindings.get('transport-b') === stableSessionId, 'reconnected transport did not reuse the stable session');
    console.log('agent-chrome session context test passed');
  } finally {
    await new Promise(resolvePromise => server.close(resolvePromise));
  }
}

main()
  .finally(() => rmSync(temp, { recursive: true, force: true }))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
