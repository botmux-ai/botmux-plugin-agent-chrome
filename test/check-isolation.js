'use strict';
// 通过 broker 模拟两个 MCP session（不同 token），验证硬隔离：
//  - 各自 getTargets 只见自己的页
//  - A 关不掉 B 的页（被拒绝）
//  - provisioning 落了 manifest
const { CDP, waitManifest } = require('../lib/cdp');
const fs = require('fs');

const BROKER = `http://127.0.0.1:${process.env.ACS_BROKER_PORT || 9300}`;
const MANIFESTS = process.env.ACS_MANIFESTS || '/data00/home/wanghao.muchen/agent-chrome/run/manifests';
const TA = 'sessAAAA' + Date.now();
const TB = 'sessBBBB' + Date.now();

async function openOne(token, color) {
  const cdp = await CDP.connectBrowser(`${BROKER}/s/${token}`);
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const { targetId } = await cdp.send('Target.createTarget', { url: `data:text/html,<body style="background:${color}">`, newWindow: true, width: 1728, height: 1117 });
  return { cdp, targetId };
}

(async () => {
  const A = await openOne(TA, 'rgb(180,0,0)');
  const B = await openOne(TB, 'rgb(0,0,180)');
  await waitManifest(BROKER, TA); await waitManifest(BROKER, TB);

  const at = (await A.cdp.send('Target.getTargets')).targetInfos.map((t) => t.targetId);
  const bt = (await B.cdp.send('Target.getTargets')).targetInfos.map((t) => t.targetId);
  console.log('A 可见 targets:', at.map(s=>s.slice(0,8)));
  console.log('B 可见 targets:', bt.map(s=>s.slice(0,8)));

  const aSeesOnlyOwn = at.includes(A.targetId) && !at.includes(B.targetId);
  const bSeesOnlyOwn = bt.includes(B.targetId) && !bt.includes(A.targetId);

  // A 试图关闭 B 的页 → 应被拒绝
  let aCloseBlocked = false;
  try {
    const r = await A.cdp.send('Target.closeTarget', { targetId: B.targetId });
    aCloseBlocked = false; // 不应成功
  } catch (e) { aCloseBlocked = /not owned/.test(e.message); }

  // A 试图 attach B 的页 → 应被拒绝
  let aAttachBlocked = false;
  try { await A.cdp.send('Target.attachToTarget', { targetId: B.targetId, flatten: true }); }
  catch (e) { aAttachBlocked = /not owned/.test(e.message); }

  // manifest 是否生成
  const mfA = fs.existsSync(`${MANIFESTS}/${TA}.json`);
  const mfB = fs.existsSync(`${MANIFESTS}/${TB}.json`);

  console.log(JSON.stringify({
    aSeesOnlyOwn, bSeesOnlyOwn, aCloseBlocked, aAttachBlocked, mfA, mfB,
  }, null, 2));

  // B 的页应仍然活着（没被 A 关掉）
  const bStillThere = (await B.cdp.send('Target.getTargets')).targetInfos.some((t) => t.targetId === B.targetId);
  console.log('B 的页仍存活:', bStillThere);

  const pass = aSeesOnlyOwn && bSeesOnlyOwn && aCloseBlocked && aAttachBlocked && mfA && mfB && bStillThere;
  console.log(pass ? 'PASS: 硬隔离生效' : 'FAIL');

  A.cdp.close(); B.cdp.close();
  setTimeout(() => process.exit(pass ? 0 : 1), 500);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
