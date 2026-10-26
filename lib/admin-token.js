'use strict';
// Broker 管理 token：远程访问 Dashboard、/sessions、/s/* 旁路接口时需带 ?token=。
// 固定放在 ~/.agent-chrome 下（不随 ACS_DATA_ROOT 变），broker 与 botmux service 读同一份。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function adminTokenFile() {
  return process.env.ACS_ADMIN_TOKEN_FILE || path.join(os.homedir(), '.agent-chrome', 'admin-token');
}

function ensureAdminToken() {
  if (process.env.ACS_ADMIN_TOKEN) return process.env.ACS_ADMIN_TOKEN;
  const file = adminTokenFile();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(24).toString('hex');
  try {
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
    return token;
  } catch (error) {
    // 并发启动时另一方先写入了，以文件为准。
    if (error.code === 'EEXIST') return fs.readFileSync(file, 'utf8').trim();
    throw error;
  }
}

function adminTokenMatches(expected, candidate) {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { adminTokenFile, ensureAdminToken, adminTokenMatches };
