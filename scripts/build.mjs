import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const finalOutputRoot = join(repoRoot, 'dist');
const outputRoot = join(repoRoot, `.dist-next-${process.pid}-${Date.now()}`);
const novncRoot = dirname(dirname(require.resolve('@novnc/novnc')));
const buildWatchDirName = 'botmux-build';

function replaceOutputContents() {
  const backupRoot = join(repoRoot, `.dist-previous-${process.pid}-${Date.now()}`);
  mkdirSync(finalOutputRoot, { recursive: true });
  mkdirSync(backupRoot, { recursive: true });
  for (const entry of readdirSync(finalOutputRoot)) {
    if (entry === buildWatchDirName) continue;
    renameSync(join(finalOutputRoot, entry), join(backupRoot, entry));
  }
  try {
    for (const entry of readdirSync(outputRoot)) {
      renameSync(join(outputRoot, entry), join(finalOutputRoot, entry));
    }
    rmSync(outputRoot, { recursive: true, force: true });
    const buildWatchDir = join(finalOutputRoot, buildWatchDirName);
    mkdirSync(buildWatchDir, { recursive: true });
    writeFileSync(join(buildWatchDir, 'stamp'), `${Date.now()}\n`);
  } catch (error) {
    for (const entry of readdirSync(finalOutputRoot)) {
      if (entry === buildWatchDirName) continue;
      rmSync(join(finalOutputRoot, entry), { recursive: true, force: true });
    }
    for (const entry of readdirSync(backupRoot)) {
      renameSync(join(backupRoot, entry), join(finalOutputRoot, entry));
    }
    rmSync(backupRoot, { recursive: true, force: true });
    throw error;
  }
}

function assertNoSymlinks(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`plugin build does not allow symlinks: ${path}`);
  if (!stat.isDirectory()) return;
  for (const name of readdirSync(path)) assertNoSymlinks(join(path, name));
}

function copyFile(source, target) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`plugin build does not allow symlinks: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { preserveTimestamps: true });
}

function copyTree(source, target) {
  if (!existsSync(source)) return;
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`plugin build does not allow symlinks: ${source}`);
  if (stat.isFile()) {
    copyFile(source, target);
    return;
  }
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name));
}

async function bundleNode(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  await build({
    entryPoints: [source],
    outfile: target,
    bundle: true,
    treeShaking: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    packages: 'bundle',
    logLevel: 'silent',
  });
}

async function bundleBrowser(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  await build({
    entryPoints: [source],
    outfile: target,
    bundle: true,
    treeShaking: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    packages: 'bundle',
    alias: {
      '@botmux/novnc-cursor': join(novncRoot, 'core', 'util', 'cursor.js'),
    },
    logLevel: 'silent',
  });
}

async function generateCliIndex() {
  const commands = await import(pathToFileURL(join(repoRoot, 'cli', 'index.js')).href + `?t=${Date.now()}`);
  const handlers = commands.default ?? commands;
  const entries = Object.entries(handlers).map(([name, handler]) => {
    if (!/^[a-z][a-z0-9._:-]{0,63}$/.test(name)) throw new Error(`invalid command name: ${name}`);
    if (typeof handler !== 'function' && typeof handler?.run !== 'function') throw new Error(`missing handler: ${name}`);
    return { name, ...(handler?.description ? { description: handler.description } : {}) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  mkdirSync(join(outputRoot, 'cli'), { recursive: true });
  writeFileSync(join(outputRoot, 'cli', 'commands.json'), JSON.stringify({ schemaVersion: 1, commands: entries }, null, 2) + '\n');
}

async function generateMcpIndex() {
  const mcpModule = await import(pathToFileURL(join(repoRoot, 'src', 'mcp', 'index.js')).href + `?t=${Date.now()}`);
  const mcp = mcpModule.default ?? mcpModule;
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) throw new Error('src/mcp/index.js must export one MCP config object');
  mkdirSync(join(outputRoot, 'mcp'), { recursive: true });
  writeFileSync(join(outputRoot, 'mcp', 'index.json'), JSON.stringify({ ...mcp, transport: mcp.transport ?? 'stdio' }, null, 2) + '\n');
}

function copyShellRuntime() {
  const source = join(repoRoot, 'bin');
  const target = join(outputRoot, 'bin');
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    if (extname(name) === '.js') continue;
    copyFile(join(source, name), join(target, name));
  }
}

function vendorChromeDevtoolsMcp() {
  const packageJson = require.resolve('chrome-devtools-mcp/package.json');
  const packageRoot = dirname(packageJson);
  const target = join(outputRoot, 'vendor', 'chrome-devtools-mcp');
  copyTree(join(packageRoot, 'build', 'src'), join(target, 'src'));
  copyFile(join(packageRoot, 'LICENSE'), join(target, 'LICENSE'));
  const upstream = JSON.parse(readFileSync(packageJson, 'utf-8'));
  writeFileSync(join(target, 'package.json'), JSON.stringify({
    name: upstream.name,
    version: upstream.version,
    private: true,
    type: 'module',
  }, null, 2) + '\n');
}

try {
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, 'package.json'), JSON.stringify({ private: true, type: 'commonjs' }, null, 2) + '\n');

  await Promise.all([
    bundleNode(join(repoRoot, 'cli', 'index.js'), join(outputRoot, 'cli', 'index.js')),
    bundleNode(join(repoRoot, 'service', 'index.js'), join(outputRoot, 'service', 'index.js')),
    bundleNode(join(repoRoot, 'service', 'runner.js'), join(outputRoot, 'service', 'runner.js')),
    bundleNode(join(repoRoot, 'src', 'mcp', 'server.js'), join(outputRoot, 'mcp', 'server.js')),
    bundleNode(join(repoRoot, 'bin', 'broker.js'), join(outputRoot, 'bin', 'broker.js')),
    bundleNode(join(repoRoot, 'bin', 'open-session.js'), join(outputRoot, 'bin', 'open-session.js')),
    bundleBrowser(join(repoRoot, 'dashboard', 'index.js'), join(outputRoot, 'dashboard', 'index.js')),
    bundleBrowser(join(repoRoot, 'novnc', 'viewer.js'), join(outputRoot, 'novnc', 'viewer.js')),
  ]);

  copyShellRuntime();
  copyTree(join(repoRoot, 'skills'), join(outputRoot, 'skills'));
  copyFile(join(repoRoot, 'novnc', 'vnc.html'), join(outputRoot, 'novnc', 'vnc.html'));
  copyFile(join(novncRoot, 'LICENSE.txt'), join(outputRoot, 'novnc', 'LICENSE.txt'));
  vendorChromeDevtoolsMcp();
  await generateCliIndex();
  await generateMcpIndex();

  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
  if (pkg.botmux?.id !== 'agent-chrome') throw new Error('package botmux.id must be agent-chrome');
  assertNoSymlinks(outputRoot);
  replaceOutputContents();
} catch (error) {
  rmSync(outputRoot, { recursive: true, force: true });
  throw error;
}
