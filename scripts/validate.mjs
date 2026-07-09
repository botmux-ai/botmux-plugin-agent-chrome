import { existsSync, readFileSync } from 'node:fs';

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

const pkg = readJson('package.json');
if (pkg.name !== '@botmux-ai/plugin-agent-chrome') fail('invalid package name');
if (!pkg.keywords?.includes('botmux-plugin')) fail('missing botmux-plugin keyword');
if (pkg.botmux?.schemaVersion !== 1) fail('invalid botmux schema');
if (pkg.botmux?.id !== 'agent-chrome') fail('invalid botmux id');
if (pkg.botmux?.service?.mode !== 'manual') fail('agent-chrome service should be manual by default');

for (const required of [
  'bin/acs-up.sh',
  'bin/acs-down.sh',
  'bin/mcp-launch.sh',
  'bin/broker.js',
  'lib/cdp.js',
  'mcp/agent-chrome.json',
  'skills/agent-chrome/SKILL.md',
  'cli/index.js',
  'cli/commands.json',
  'dashboard/index.js',
  'service/index.js',
  'service/runner.js',
]) {
  if (!existsSync(required)) fail(`missing required file: ${required}`);
}

const mcp = readJson('mcp/agent-chrome.json');
if (mcp.name !== 'agent-chrome') fail('invalid mcp server name');
if (!Array.isArray(mcp.command) || mcp.command[0] !== './bin/mcp-launch.sh') fail('invalid mcp command');

const commandIndex = readJson('cli/commands.json');
if (!commandIndex.commands?.some(command => command.name === 'agent-chrome:status')) fail('missing cli command');

console.log('agent-chrome plugin validation passed');

