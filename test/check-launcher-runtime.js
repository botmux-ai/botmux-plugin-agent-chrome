const { chmodSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');

const root = resolve(__dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'agent-chrome-launcher-'));
const fakeMcp = join(temp, 'fake-mcp.js');

writeFileSync(fakeMcp, `#!/usr/bin/env node
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-chrome-launcher-smoke', version: '1.0.0' }
      }
    }) + '\\n');
  } else if (request.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: { tools: [{ name: 'fake_chrome_tool', description: 'fake', inputSchema: { type: 'object' } }] }
    }) + '\\n');
  }
});
`);
chmodSync(fakeMcp, 0o755);

function runLauncher(extraEnv, sendInitialize) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(join(root, 'dist', 'bin', 'mcp-launch.sh'), [], {
      cwd: root,
      env: {
        ...process.env,
        ACS_ROOT: temp,
        ACS_RUN: join(temp, 'run'),
        ACS_MCP_BIN: fakeMcp,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`launcher timeout: ${stderr}`));
    }, 5_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let requestedTools = false;
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (sendInitialize && !requestedTools && stdout.includes('agent-chrome-launcher-smoke')) {
        requestedTools = true;
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
      }
      if (sendInitialize && stdout.includes('fake_chrome_tool') && stdout.includes('browser_session_info')) {
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });

    if (sendInitialize) {
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'agent-chrome-test', version: '1.0.0' },
        },
      }) + '\n');
    } else {
      child.stdin.end();
    }
  });
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major > 20 || (major === 20 && minor >= 19))) {
    throw new Error(`test requires Node.js >=20.19.0, got ${process.version}`);
  }

  const handshake = await runLauncher({ ACS_NODE_BIN: process.execPath }, true);
  if (!handshake.stdout.includes('agent-chrome-launcher-smoke')) {
    throw new Error(`launcher handshake failed: ${handshake.stderr || handshake.stdout}`);
  }
  if (!handshake.stdout.includes('fake_chrome_tool') || !handshake.stdout.includes('browser_session_info')) {
    throw new Error(`composite MCP did not merge downstream and session tools: ${handshake.stderr || handshake.stdout}`);
  }

  const incompatible = await runLauncher({ ACS_NODE_BIN: '/usr/bin/false' }, false);
  if (incompatible.code !== 127 || !incompatible.stderr.includes('Node.js >=20.19.0')) {
    throw new Error(`launcher did not reject incompatible Node.js: ${incompatible.stderr}`);
  }

  console.log('agent-chrome launcher runtime test passed');
}

main()
  .finally(() => rmSync(temp, { recursive: true, force: true }))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
