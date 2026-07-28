'use strict';

const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function loadDashboard() {
  const source = readFileSync(join(root, 'dist', 'dashboard', 'index.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

async function main() {
  const dashboard = await loadDashboard();
  assert(typeof dashboard.copyText === 'function', 'dashboard copy helper is not exported');

  let clipboardValue = null;
  setGlobal('navigator', { clipboard: { writeText: async value => { clipboardValue = value; } } });
  await dashboard.copyText('clipboard-value');
  assert(clipboardValue === 'clipboard-value', 'Clipboard API path did not copy the value');

  let appended = null;
  let command = null;
  let removed = false;
  const textarea = {
    value: '',
    style: {},
    setAttribute() {},
    focus() {},
    select() {},
    setSelectionRange() {},
    remove() { removed = true; },
  };
  setGlobal('navigator', {});
  setGlobal('document', {
    body: { appendChild(node) { appended = node; } },
    createElement(tag) {
      assert(tag === 'textarea', 'copy fallback must create a textarea');
      return textarea;
    },
    execCommand(value) {
      command = value;
      return true;
    },
  });
  await dashboard.copyText('fallback-value');
  assert(appended === textarea, 'copy fallback did not attach its textarea');
  assert(textarea.value === 'fallback-value', 'copy fallback used the wrong value');
  assert(command === 'copy', 'copy fallback did not invoke copy');
  assert(removed, 'copy fallback did not clean up its textarea');

  console.log('agent-chrome dashboard copy test passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
