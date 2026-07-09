import { readFileSync, writeFileSync } from 'node:fs';

const commands = await import('../cli/index.js');
const handlers = commands.default ?? commands;
const entries = Object.entries(handlers).map(([name, handler]) => {
  if (!/^[a-z][a-z0-9._:-]{0,63}$/.test(name)) throw new Error(`invalid command name: ${name}`);
  if (typeof handler !== 'function' && typeof handler?.run !== 'function') throw new Error(`missing handler: ${name}`);
  return {
    name,
    ...(handler?.description ? { description: handler.description } : {}),
  };
}).sort((a, b) => a.name.localeCompare(b.name));

writeFileSync('cli/commands.json', JSON.stringify({ schemaVersion: 1, commands: entries }, null, 2) + '\n');

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
if (pkg.botmux?.id !== 'agent-chrome') throw new Error('package botmux.id must be agent-chrome');

