import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const runtimeRoot = 'dist';

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function assertNoSymlinks(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) fail(`plugin dist must not contain symlinks: ${path}`);
  if (!stat.isDirectory()) return;
  for (const name of readdirSync(path)) assertNoSymlinks(join(path, name));
}

const pkg = readJson('package.json');
if (pkg.name !== '@botmux-ai/plugin-agent-chrome') fail('invalid package name');
if (!pkg.keywords?.includes('botmux-plugin')) fail('missing botmux-plugin keyword');
if (pkg.botmux?.id !== 'agent-chrome') fail('invalid botmux id');
if (pkg.botmux?.service?.mode !== 'auto') fail('agent-chrome service should start automatically with botmux');
if (pkg.files?.length !== 1 || pkg.files[0] !== 'dist/') fail('package files must publish only dist/');
if (pkg.publishConfig?.registry !== 'https://registry.npmjs.org/' || pkg.publishConfig?.access !== 'public') {
  fail('agent-chrome must publish publicly to npmjs');
}
if (Object.keys(pkg.dependencies ?? {}).length !== 0) fail('runtime dependencies must be bundled into dist/');
if (pkg.devDependencies?.['chrome-devtools-mcp'] !== '1.5.0') fail('chrome-devtools-mcp build input must stay pinned');
if (!pkg.devDependencies?.esbuild) fail('esbuild is required to bundle the plugin runtime');
if (!pkg.devDependencies?.react) fail('React is required to build the plugin dashboard component');

for (const required of [
  'dist/package.json',
  'dist/bin/acs-up.sh',
  'dist/bin/acs-down.sh',
  'dist/bin/mcp-launch.sh',
  'dist/bin/broker.js',
  'dist/cli/index.js',
  'dist/cli/commands.json',
  'dist/dashboard/index.js',
  'dist/mcp/index.json',
  'dist/mcp/server.js',
  'dist/service/index.js',
  'dist/service/runner.js',
  'dist/skills/agent-chrome/SKILL.md',
  'dist/vendor/chrome-devtools-mcp/package.json',
  'dist/vendor/chrome-devtools-mcp/LICENSE',
  'dist/vendor/chrome-devtools-mcp/src/bin/chrome-devtools-mcp.js',
]) {
  if (!existsSync(required)) fail(`missing required runtime file: ${required}`);
}
assertNoSymlinks(runtimeRoot);

const runtimePackage = readJson('dist/package.json');
if (runtimePackage.type !== 'commonjs') fail('dist/package.json must declare the bundled Node runtime as commonjs');

const mcp = readJson('dist/mcp/index.json');
if (mcp.name !== undefined || mcp.transport !== 'stdio') fail('invalid single MCP config');
if (!Array.isArray(mcp.command) || mcp.command.length !== 1 || mcp.command[0] !== './bin/mcp-launch.sh') fail('invalid MCP command');
const mcpLauncher = readFileSync('dist/bin/mcp-launch.sh', 'utf-8');
if (!mcpLauncher.includes('mcp/server.js')) fail('MCP launcher must use the composite MCP server');
if (mcpLauncher.includes('node_modules/.bin/chrome-devtools-mcp')) fail('MCP launcher must not depend on node_modules');
if (!mcpLauncher.includes('ACS_NODE_BIN')) fail('MCP launcher must support an explicit Node.js runtime');
if (!mcpLauncher.includes('Node.js >=20.19.0')) fail('MCP launcher must enforce the MCP Node.js requirement');
const mcpServer = readFileSync('dist/mcp/server.js', 'utf-8');
if (!mcpServer.includes('"vendor"') || !mcpServer.includes('"chrome-devtools-mcp"')) {
  fail('composite MCP server must proxy the bundled Chrome DevTools MCP');
}
for (const tool of ['browser_session_info', 'browser_session_set_writable']) {
  if (!mcpServer.includes(tool)) fail(`composite MCP server is missing ${tool}`);
}
for (const removedTool of [
  'browser_session_get_vnc_url',
  'browser_session_screenshot',
  'browser_session_activate',
  'browser_session_send_keys',
  'browser_session_click',
]) {
  if (mcpServer.includes(removedTool)) fail(`composite MCP server still exposes removed tool ${removedTool}`);
}
for (const marker of ['list_pages', 'new_page', 'sessionId', '/bind', 'No active Agent Chrome page']) {
  if (!mcpServer.includes(marker)) fail(`composite MCP server is missing session binding marker: ${marker}`);
}

const broker = readFileSync('dist/bin/broker.js', 'utf-8');
for (const marker of ['.agent-chrome', 'websockify exited with', 'transportBindings', 'reconnectGraceMs']) {
  if (!broker.includes(marker)) fail(`broker is missing runtime lifecycle marker: ${marker}`);
}
if (!broker.includes('-nocursorshape')) {
  fail('x11vnc must render the cursor into the framebuffer so noVNC scales it with the display');
}
if (broker.includes('process.chdir(') || broker.includes('cwd: CFG.runtimeDir')) {
  fail('broker and VNC subprocesses must keep the plugin runtime working directory');
}
const runtimeEnv = readFileSync('dist/bin/env.sh', 'utf-8');
if (!runtimeEnv.includes('/.agent-chrome')) fail('runtime data must default to ~/.agent-chrome');
const stackLauncher = readFileSync('dist/bin/acs-up.sh', 'utf-8');
if (stackLauncher.includes('cd "$ACS_RUN"')) fail('stack launcher must not migrate process cwd into the data directory');

const commandIndex = readJson('dist/cli/commands.json');
if (!commandIndex.commands?.some(command => command.name === 'agent-chrome:status')) fail('missing CLI command');

const dashboard = readFileSync('dist/dashboard/index.js', 'utf-8');
for (const marker of ['ac-session-list', 'view-mode', '/api/sessions', 'free-target', 'novncUrl']) {
  if (!dashboard.includes(marker)) fail(`dashboard is missing ${marker}`);
}

const cleanRoot = mkdtempSync(join(tmpdir(), 'agent-chrome-dist-'));
try {
  cpSync(runtimeRoot, cleanRoot, { recursive: true });
  const cleanRequire = createRequire(join(cleanRoot, 'validate.cjs'));
  const handlers = cleanRequire(join(cleanRoot, 'cli', 'index.js'));
  if (typeof handlers?.['agent-chrome:status']?.run !== 'function') fail('clean dist CLI bundle is not loadable');
  const service = cleanRequire(join(cleanRoot, 'service', 'index.js'));
  if (service?.mode !== 'auto') fail('clean dist service should use auto mode');
  if (service?.pm2?.script !== './service/runner.js') fail('clean dist service bundle is not loadable');
  if (service?.pm2?.cwd !== undefined) fail('service cwd must remain the plugin runtime directory managed by Botmux');

  const vendoredMcp = spawnSync(process.execPath, [
    join(cleanRoot, 'vendor', 'chrome-devtools-mcp', 'src', 'bin', 'chrome-devtools-mcp.js'),
    '--version',
  ], {
    cwd: cleanRoot,
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (vendoredMcp.status !== 0 || !String(vendoredMcp.stdout).includes('1.5.0')) {
    fail(`vendored chrome-devtools-mcp is not self-contained: ${vendoredMcp.stderr || vendoredMcp.stdout}`);
  }
} finally {
  rmSync(cleanRoot, { recursive: true, force: true });
}

console.log('agent-chrome plugin validation passed');
