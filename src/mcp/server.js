'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, isAbsolute, join, resolve } = require('node:path');

const pluginRoot = resolve(__dirname, '..');
const brokerPort = Number(process.env.ACS_BROKER_PORT || 9300);
const display = process.env.ACS_DISPLAY || ':77';
const token = process.env.ACS_SESSION_TOKEN || randomUUID();
const brokerSessionUrl = `http://127.0.0.1:${brokerPort}/s/${encodeURIComponent(token)}`;
const mcpEntry = process.env.ACS_MCP_BIN
  || join(pluginRoot, 'vendor', 'chrome-devtools-mcp', 'src', 'bin', 'chrome-devtools-mcp.js');
const wsEndpoint = `ws://127.0.0.1:${brokerPort}/s/${token}/devtools/browser/${randomUUID().replaceAll('-', '')}`;

const LOCAL_TOOLS = [
  {
    name: 'browser_session_info',
    description: 'Get the visible Agent Chrome window, noVNC URL, and interaction state for this MCP session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_session_get_vnc_url',
    description: 'Get the noVNC URL for viewing or taking over this MCP session browser window.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_session_set_writable',
    description: 'Allow or prevent human input through noVNC for this MCP session browser window.',
    inputSchema: {
      type: 'object',
      properties: {
        writable: { type: 'boolean', description: 'True allows noVNC input; false returns to view-only mode.' },
      },
      required: ['writable'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_session_screenshot',
    description: 'Capture the native Agent Chrome window for this MCP session, including browser chrome.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Optional absolute path, or path relative to the MCP working directory, ending in .png.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_session_activate',
    description: 'Bring the native Agent Chrome window for this MCP session to the front.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_session_send_keys',
    description: 'Send a bounded list of xdotool key expressions to this MCP session browser window.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 128 },
          minItems: 1,
          maxItems: 32,
          description: 'Key expressions such as Control_L+l, Return, or Escape.',
        },
      },
      required: ['keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_session_click',
    description: 'Click native window coordinates inside this MCP session browser window.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'integer', minimum: 0 },
        y: { type: 'integer', minimum: 0 },
        button: { type: 'integer', minimum: 1, maximum: 5, default: 1 },
      },
      required: ['x', 'y'],
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

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error || `Agent Chrome broker returned HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function safeManifest(manifest) {
  return {
    display: manifest.DISPLAY || display,
    geometry: manifest.geometry || null,
    windowIds: Array.isArray(manifest.windowIds) ? manifest.windowIds : [],
    primaryWindowId: manifest.primaryWindowId || null,
    vncPort: manifest.vncPort || null,
    novncPort: manifest.novncPort || null,
    novncUrl: manifest.novncUrl || null,
    viewonly: manifest.viewonly !== false,
    updatedAt: manifest.updatedAt || null,
  };
}

async function manifest() {
  return safeManifest(await fetchJson(`${brokerSessionUrl}/manifest`));
}

async function primaryWindow() {
  const current = await manifest();
  if (!current.primaryWindowId) throw new Error('No visible Agent Chrome window exists yet. Open a page first.');
  return { current, windowId: String(current.primaryWindowId) };
}

async function windowSize(windowId) {
  const { stdout } = await run('xdotool', ['getwindowgeometry', '--shell', windowId], { env: { DISPLAY: display } });
  const width = Number(stdout.match(/^WIDTH=(\d+)$/m)?.[1]);
  const height = Number(stdout.match(/^HEIGHT=(\d+)$/m)?.[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error('Could not read the Agent Chrome window bounds');
  return { width, height };
}

function run(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
      env: { ...process.env, ...options.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${file} exited with ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

async function callLocalTool(name, rawArgs) {
  const args = requireObject(rawArgs);
  if (name === 'browser_session_info') {
    const current = await manifest();
    return textResult(JSON.stringify(current, null, 2), { structuredContent: current });
  }
  if (name === 'browser_session_get_vnc_url') {
    const current = await manifest();
    if (!current.novncUrl) throw new Error('The noVNC view is not ready yet. Open a page first.');
    return textResult(current.novncUrl, { structuredContent: { url: current.novncUrl, viewonly: current.viewonly } });
  }
  if (name === 'browser_session_set_writable') {
    if (typeof args.writable !== 'boolean') throw new Error('writable must be a boolean');
    const state = await fetchJson(`${brokerSessionUrl}/viewonly?on=${args.writable ? '0' : '1'}`);
    if (!state.ok) throw new Error('Agent Chrome could not update the noVNC interaction mode');
    const result = { writable: state.viewonly === false, viewonly: state.viewonly !== false };
    return textResult(result.writable ? 'noVNC input enabled' : 'noVNC returned to view-only mode', { structuredContent: result });
  }
  if (name === 'browser_session_screenshot') {
    const { windowId } = await primaryWindow();
    const requestedPath = typeof args.filePath === 'string' && args.filePath.trim() ? args.filePath.trim() : undefined;
    if (requestedPath && !requestedPath.toLowerCase().endsWith('.png')) throw new Error('filePath must end in .png');
    const tempDir = requestedPath ? undefined : mkdtempSync(join(tmpdir(), 'agent-chrome-window-'));
    const target = requestedPath
      ? (isAbsolute(requestedPath) ? requestedPath : resolve(process.cwd(), requestedPath))
      : join(tempDir, 'window.png');
    mkdirSync(dirname(target), { recursive: true });
    try {
      await run('import', ['-window', windowId, target], { env: { DISPLAY: display } });
      if (requestedPath) return textResult(`Saved native browser window screenshot to ${target}`, { structuredContent: { filePath: target } });
      const data = readFileSync(target).toString('base64');
      return {
        content: [
          { type: 'text', text: 'Captured the native browser window for this MCP session.' },
          { type: 'image', data, mimeType: 'image/png' },
        ],
      };
    } finally {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }
  }
  if (name === 'browser_session_activate') {
    const { windowId } = await primaryWindow();
    try {
      await run('xdotool', ['windowactivate', windowId], { env: { DISPLAY: display } });
    } catch {
      await run('xdotool', ['windowraise', windowId], { env: { DISPLAY: display } });
    }
    return textResult('Activated the native browser window for this MCP session.');
  }
  if (name === 'browser_session_send_keys') {
    if (!Array.isArray(args.keys) || args.keys.length < 1 || args.keys.length > 32
      || args.keys.some(key => typeof key !== 'string' || !/^[A-Za-z0-9_+:-]{1,128}$/.test(key))) {
      throw new Error('keys must contain between 1 and 32 non-empty key expressions');
    }
    const { windowId } = await primaryWindow();
    await run('xdotool', ['key', '--window', windowId, '--clearmodifiers', ...args.keys], { env: { DISPLAY: display } });
    return textResult(`Sent ${args.keys.length} key expression(s) to this MCP session window.`);
  }
  if (name === 'browser_session_click') {
    if (!Number.isInteger(args.x) || args.x < 0 || !Number.isInteger(args.y) || args.y < 0) {
      throw new Error('x and y must be non-negative integers');
    }
    const button = args.button === undefined ? 1 : args.button;
    if (!Number.isInteger(button) || button < 1 || button > 5) throw new Error('button must be an integer from 1 to 5');
    const { windowId } = await primaryWindow();
    const { width, height } = await windowSize(windowId);
    if (args.x >= width || args.y >= height) throw new Error(`click coordinates must stay inside the ${width}x${height} session window`);
    await run('xdotool', ['mousemove', '--window', windowId, String(args.x), String(args.y), 'click', String(button)], { env: { DISPLAY: display } });
    return textResult(`Clicked (${args.x}, ${args.y}) in this MCP session window.`);
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

processLines(process.stdin, line => {
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
    void callLocalTool(message.params.name, message.params.arguments)
      .then(result => writeMessage({ jsonrpc: '2.0', id, result }))
      .catch(error => writeMessage({ jsonrpc: '2.0', id, result: errorResult(error) }));
    return;
  }
  if (method === 'tools/list' && id !== undefined) {
    pending.set(idKey(id), { method: 'tools/list', includeLocal: !message.params?.cursor });
  }
  downstream.stdin.write(`${line}\n`);
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
      const names = new Set(message.result.tools.map(tool => tool?.name));
      message.result.tools.push(...LOCAL_TOOLS.filter(tool => !names.has(tool.name)));
    }
  }
  writeMessage(message);
});

process.stdin.on('end', () => downstream.stdin.end());
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
