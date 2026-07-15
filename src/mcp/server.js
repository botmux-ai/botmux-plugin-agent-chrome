'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const pluginRoot = resolve(__dirname, '..');
const brokerPort = Number(process.env.ACS_BROKER_PORT || 9300);
const transportToken = process.env.ACS_SESSION_TOKEN || randomUUID();
const trustedSessionId = process.env.BOTMUX_SESSION_ID?.trim() || null;
const brokerSessionUrl = `http://127.0.0.1:${brokerPort}/s/${encodeURIComponent(transportToken)}`;
const mcpEntry = process.env.ACS_MCP_BIN
  || join(pluginRoot, 'vendor', 'chrome-devtools-mcp', 'src', 'bin', 'chrome-devtools-mcp.js');
const wsEndpoint = `ws://127.0.0.1:${brokerPort}/s/${transportToken}/devtools/browser/${randomUUID().replaceAll('-', '')}`
  + (trustedSessionId ? `?botmuxSessionId=${encodeURIComponent(trustedSessionId)}` : '');

const SESSION_ENTRY_TOOL_NAMES = new Set([
  'list_pages',
  'new_page',
  'browser_session_info',
  'browser_session_set_writable',
]);
const SESSION_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description: 'Stable session identifier. In botmux, pass the exact value from the current <session_id> context.',
};

const LOCAL_TOOLS = [
  {
    name: 'browser_session_info',
    description: 'Get the visible Agent Chrome window, noVNC URL, and interaction state for this MCP session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID_SCHEMA,
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_session_set_writable',
    description: 'Allow or prevent human input through noVNC for this MCP session browser window.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID_SCHEMA,
        writable: { type: 'boolean', description: 'True allows noVNC input; false returns to view-only mode.' },
        mode: { type: 'string', enum: ['follow', 'free'], default: 'follow' },
      },
      required: ['sessionId', 'writable'],
      additionalProperties: false,
    },
  },
];
const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOLS.map(tool => tool.name));

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(text, extra = {}) {
  return { content: [{ type: 'text', text }], ...extra };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return textResult(message, { isError: true });
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error || `Agent Chrome broker returned HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function safeManifest(manifest) {
  return {
    botmuxSessionId: manifest.botmuxSessionId || null,
    display: manifest.DISPLAY || null,
    geometry: manifest.geometry || null,
    windowIds: Array.isArray(manifest.windowIds) ? manifest.windowIds : [],
    primaryWindowId: manifest.primaryWindowId || null,
    vncPort: manifest.vncPort || null,
    novncPort: manifest.novncPort || null,
    novncUrl: manifest.novncUrl || null,
    viewonly: manifest.viewonly !== false,
    mode: manifest.mode === 'free' ? 'free' : 'follow',
    agentActiveTargetId: manifest.agentActiveTargetId || null,
    pages: Array.isArray(manifest.pages) ? manifest.pages.map(page => ({
      targetId: page.targetId,
      windowId: page.windowId,
      title: page.title || '',
      url: page.url || '',
      createdAt: page.createdAt || null,
      lastActiveAt: page.lastActiveAt || null,
    })) : [],
    follow: manifest.follow || null,
    free: manifest.free || { enabled: false },
    updatedAt: manifest.updatedAt || null,
  };
}

async function manifest() {
  return safeManifest(await fetchJson(`${brokerSessionUrl}/manifest`));
}

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function normalizeSessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('sessionId must be a non-empty identifier containing only letters, numbers, dot, underscore, colon, or hyphen');
  }
  if (trustedSessionId && value !== trustedSessionId) {
    throw new Error('sessionId does not match the current botmux session');
  }
  return value;
}

let boundSessionId = null;
let downstreamBound = false;

async function registerBrokerBinding(sessionId) {
  await fetchJson(`${brokerSessionUrl}/bind`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
}

async function bindSession(rawArgs) {
  const args = requireObject(rawArgs);
  const sessionId = normalizeSessionId(args.sessionId);
  if (boundSessionId && boundSessionId !== sessionId) {
    throw new Error(`This MCP connection is already bound to session ${boundSessionId}`);
  }
  await registerBrokerBinding(sessionId);
  boundSessionId = sessionId;
  const forwarded = { ...args };
  delete forwarded.sessionId;
  return forwarded;
}

function withSessionIdSchema(tool) {
  const schema = requireObject(tool.inputSchema);
  const properties = { ...requireObject(schema.properties), sessionId: SESSION_ID_SCHEMA };
  const required = [...new Set([...(Array.isArray(schema.required) ? schema.required : []), 'sessionId'])];
  return { ...tool, inputSchema: { ...schema, type: 'object', properties, required } };
}

async function callLocalTool(name, rawArgs) {
  const args = requireObject(rawArgs);
  if (name === 'browser_session_info') {
    const current = await manifest();
    return textResult(JSON.stringify(current, null, 2), { structuredContent: current });
  }
  if (name === 'browser_session_set_writable') {
    if (typeof args.writable !== 'boolean') throw new Error('writable must be a boolean');
    const mode = args.mode === 'free' ? 'free' : 'follow';
    const state = await fetchJson(`${brokerSessionUrl}/viewonly?mode=${mode}&on=${args.writable ? '0' : '1'}`);
    if (!state.ok) throw new Error('Agent Chrome could not update the noVNC interaction mode');
    const result = { mode, writable: state.viewonly === false, viewonly: state.viewonly !== false };
    return textResult(result.writable ? 'noVNC input enabled' : 'noVNC returned to view-only mode', { structuredContent: result });
  }
  throw new Error(`Unknown Agent Chrome session tool: ${name}`);
}

if (!existsSync(mcpEntry)) {
  process.stderr.write('agent-chrome: chrome-devtools-mcp entry is missing\n');
  process.exit(127);
}

const downstream = spawn(process.execPath, [mcpEntry, `--wsEndpoint=${wsEndpoint}`, ...process.argv.slice(2)], {
  cwd: pluginRoot,
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
});
const pending = new Map();

function idKey(id) {
  return `${typeof id}:${String(id)}`;
}

function processLines(stream, onLine) {
  stream.setEncoding('utf8');
  let buffer = '';
  stream.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onLine(line);
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) onLine(buffer);
  });
}

async function handleClientLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    downstream.stdin.write(`${line}\n`);
    return;
  }

  const method = message?.method;
  const id = message?.id;
  if (method === 'tools/call' && id !== undefined && LOCAL_TOOL_NAMES.has(message.params?.name)) {
    try {
      const args = await bindSession(message.params.arguments);
      const result = await callLocalTool(message.params.name, args);
      writeMessage({ jsonrpc: '2.0', id, result });
    } catch (error) {
      writeMessage({ jsonrpc: '2.0', id, result: errorResult(error) });
    }
    return;
  }
  if (method === 'tools/call' && id !== undefined) {
    const name = message.params?.name;
    if (SESSION_ENTRY_TOOL_NAMES.has(name)) {
      try {
        message.params.arguments = await bindSession(message.params.arguments);
      } catch (error) {
        writeMessage({ jsonrpc: '2.0', id, result: errorResult(error) });
        return;
      }
    } else if (!boundSessionId) {
      writeMessage({
        jsonrpc: '2.0',
        id,
        result: errorResult('No active Agent Chrome page for this MCP connection. Call list_pages or new_page with sessionId first.'),
      });
      return;
    } else if (!downstreamBound) {
      try {
        await registerBrokerBinding(boundSessionId);
      } catch (error) {
        writeMessage({ jsonrpc: '2.0', id, result: errorResult(error) });
        return;
      }
    }
    downstreamBound = true;
  }
  if (method === 'tools/list' && id !== undefined) {
    pending.set(idKey(id), { method: 'tools/list', includeLocal: !message.params?.cursor });
  }
  downstream.stdin.write(`${JSON.stringify(message)}\n`);
}

let clientQueue = Promise.resolve();
processLines(process.stdin, line => {
  clientQueue = clientQueue
    .then(() => handleClientLine(line))
    .catch(error => process.stderr.write(`agent-chrome: request handling failed: ${error.message}\n`));
});

processLines(downstream.stdout, line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(`${line}\n`);
    return;
  }

  if (message?.id !== undefined && message.method === undefined) {
    const key = idKey(message.id);
    const request = pending.get(key);
    pending.delete(key);
    if (request?.method === 'tools/list' && request.includeLocal && Array.isArray(message.result?.tools)) {
      message.result.tools = message.result.tools.map(tool => (
        SESSION_ENTRY_TOOL_NAMES.has(tool?.name) ? withSessionIdSchema(tool) : tool
      ));
      const names = new Set(message.result.tools.map(tool => tool?.name));
      message.result.tools.push(...LOCAL_TOOLS.filter(tool => !names.has(tool.name)));
    }
  }
  writeMessage(message);
});

process.stdin.on('end', () => {
  void clientQueue.finally(() => downstream.stdin.end());
});
downstream.on('error', error => {
  process.stderr.write(`agent-chrome: failed to start chrome-devtools-mcp: ${error.message}\n`);
  process.exitCode = 1;
});
downstream.on('exit', (code, signal) => {
  if (signal) process.exit(0);
  process.exit(code ?? 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!downstream.killed) downstream.kill(signal);
  });
}
