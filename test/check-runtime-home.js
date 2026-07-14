const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'agent-chrome-home-'));
const envScript = join(root, 'dist', 'bin', 'env.sh');

function readRuntimeEnv(extraEnv = {}) {
  const output = execFileSync('bash', [
    '-c',
    'source "$1"; printf "%s\n" "$ACS_DATA_ROOT" "$ACS_PROFILE" "$ACS_RUN" "$ACS_LOGS" "$ACS_TMP" "$ACS_MANIFESTS"',
    'bash',
    envScript,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: temp,
      AGENT_CHROME_HOME: '',
      ACS_DATA_ROOT: '',
      ACS_PROFILE: '',
      ACS_RUN: '',
      ACS_LOGS: '',
      ACS_TMP: '',
      ACS_MANIFESTS: '',
      BOTMUX_PLUGIN_HOME: join(temp, '.botmux', 'plugins', 'agent-chrome'),
      ...extraEnv,
    },
  });
  const [dataRoot, profile, run, logs, runtimeTmp, manifests] = output.trim().split('\n');
  return { dataRoot, profile, run, logs, runtimeTmp, manifests };
}

function assertRuntimeLayout(actual, expectedRoot) {
  const expected = {
    dataRoot: expectedRoot,
    profile: join(expectedRoot, 'profile'),
    run: join(expectedRoot, 'run'),
    logs: join(expectedRoot, 'logs'),
    runtimeTmp: join(expectedRoot, 'tmp'),
    manifests: join(expectedRoot, 'run', 'manifests'),
  };
  for (const [name, value] of Object.entries(expected)) {
    if (actual[name] !== value) throw new Error(`${name} mismatch: expected ${value}, got ${actual[name]}`);
    if (name !== 'dataRoot' && !existsSync(value)) throw new Error(`${name} directory was not created: ${value}`);
  }
}

try {
  const defaultRoot = join(temp, '.agent-chrome');
  assertRuntimeLayout(readRuntimeEnv(), defaultRoot);

  const namedHome = join(temp, 'named-home');
  assertRuntimeLayout(readRuntimeEnv({ AGENT_CHROME_HOME: namedHome }), namedHome);

  const explicitRoot = join(temp, 'explicit-root');
  assertRuntimeLayout(readRuntimeEnv({
    AGENT_CHROME_HOME: namedHome,
    ACS_DATA_ROOT: explicitRoot,
  }), explicitRoot);

  console.log('agent-chrome runtime home test passed');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
