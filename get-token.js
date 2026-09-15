/**
 * 微信小程序 Token 提取工具
 *
 * 通过 WMPFDebugger 暴露的 CDP 代理，attach 到小程序的页面 target，
 * 逐个枚举执行上下文，找到逻辑层里带 getStorageInfoSync 的那个，
 * 再从 storage 里读出 token。
 *
 * 读的是本机微信当前登录账号的会话，因此只能取到操作者自己的 token。
 *
 * 依赖 WMPFDebugger —— 微信小程序调试工具，作者 evi0s，GPLv2：
 *   https://github.com/evi0s/WMPFDebugger
 * 本脚本不包含其任何代码，仅通过 WebSocket 连接其 CDP 代理。
 */

const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const CDP_PORT = Number(process.env.CDP_PORT || 62000);
const CDP_URL = `ws://127.0.0.1:${CDP_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 定位 WMPFDebugger 目录 ----------
function findDebuggerDir() {
  const candidates = [
    process.env.WMPF_DEBUGGER_DIR,
    path.join(__dirname, 'WMPFDebugger'),
    path.join(__dirname, '..', 'WMPFDebugger'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'src', 'index.ts'))) return c;
  }
  return null;
}

// ---------- 端口探测 ----------
function isPortOpen(port, timeout = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, '127.0.0.1');
  });
}

// ---------- 必要时自动拉起调试服务 ----------
let spawnedServer = null;

async function ensureServer() {
  if (await isPortOpen(CDP_PORT)) {
    console.log('调试服务已在运行。\n');
    return;
  }

  const dir = findDebuggerDir();
  if (!dir) {
    console.error('调试服务没在运行，也找不到 WMPFDebugger 目录。\n');
    console.error('请先安装 WMPFDebugger（https://github.com/evi0s/WMPFDebugger）：');
    console.error('  git clone https://github.com/evi0s/WMPFDebugger');
    console.error('  cd WMPFDebugger && yarn install');
    console.error('\n把它放在本脚本同级目录，或用环境变量指定：');
    console.error('  set WMPF_DEBUGGER_DIR=<WMPFDebugger 的完整路径>');
    process.exit(1);
  }

  // 优先用 ts-node 的入口 JS，避免依赖 yarn/npx 是否在 PATH 里
  const binJs = path.join(dir, 'node_modules', 'ts-node', 'dist', 'bin.js');
  const shim = path.join(
    dir, 'node_modules', '.bin',
    process.platform === 'win32' ? 'ts-node.cmd' : 'ts-node'
  );

  let cmd, args, opts;
  if (fs.existsSync(binJs)) {
    cmd = process.execPath;
    args = [binJs, 'src/index.ts'];
    opts = { cwd: dir, stdio: 'ignore', windowsHide: true };
  } else if (fs.existsSync(shim)) {
    cmd = shim;
    args = ['src/index.ts'];
    opts = { cwd: dir, stdio: 'ignore', shell: true, windowsHide: true };
  } else {
    console.error('WMPFDebugger 的依赖没装好（找不到 ts-node）。');
    console.error('请先进它的目录执行：yarn install');
    process.exit(1);
  }

  console.log('调试服务未运行，正在自动启动…');
  spawnedServer = spawn(cmd, args, opts);
  spawnedServer.on('error', (e) => {
    console.error('启动调试服务失败：' + e.message);
    process.exit(1);
  });

  // 等服务起来（含 frida 注入，通常几秒）
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await isPortOpen(CDP_PORT)) {
      await sleep(2000); // 再等 frida 把钩子挂稳
      console.log('调试服务已启动。\n');
      return;
    }
  }

  cleanup();
  console.error('调试服务启动超时。');
  console.error('请手动进 WMPFDebugger 目录执行：corepack yarn ts-node src/index.ts');
  console.error('看看报什么错再回来。');
  process.exit(1);
}

function cleanup() {
  if (spawnedServer && !spawnedServer.killed) {
    try { spawnedServer.kill(); } catch (_) { /* 忽略 */ }
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ---------- 定位 ws 模块 ----------
function loadWs() {
  const dir = findDebuggerDir();
  const candidates = [
    dir && path.join(dir, 'node_modules', 'ws'),
    path.join(__dirname, 'node_modules', 'ws'),
    'ws',
  ].filter(Boolean);

  for (const c of candidates) {
    try { return require(c); } catch (_) { /* 继续试 */ }
  }
  return null;
}

// ---------- CDP 客户端 ----------
let ws = null;
let seq = 0;
const pending = new Map();
const contexts = new Map();
let session = null;

function send(method, params, withSession, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求超时: ${method}`));
    }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    const m = { id, method, params: params || {} };
    if (withSession && session) m.sessionId = session;
    ws.send(JSON.stringify(m));
  });
}

function connect() {
  const WebSocket = loadWs();
  if (!WebSocket) {
    console.error('找不到 ws 模块。请确认 WMPFDebugger 已执行过 yarn install。');
    process.exit(1);
  }

  ws = new WebSocket(CDP_URL);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const fn = pending.get(msg.id);
      pending.delete(msg.id);
      fn(msg);
      return;
    }
    if (msg.method === 'Runtime.executionContextCreated' && msg.sessionId) {
      contexts.set(msg.params.context.id, msg.params.context);
    }
  });

  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

async function evaluate(expression, contextId) {
  const params = { expression, returnByValue: true, awaitPromise: true };
  if (contextId !== undefined) params.contextId = contextId;
  const r = await send('Runtime.evaluate', params, true);
  if (r.error) return { err: r.error.message };
  const res = r.result || {};
  if (res.exceptionDetails) return { err: res.exceptionDetails.text };
  return { ok: res.result ? res.result.value : undefined };
}

// ---------- 找小程序 target ----------
// 注意：小程序还没挂上时，Target.getTargets 会直接挂起而不是返回空列表，
// 所以这里把超时当成「暂时没有小程序」处理，交给外层轮询重试。
async function findMiniappTargets() {
  let t;
  try {
    t = await send('Target.getTargets', {}, false, 4000);
  } catch (_) {
    return [];
  }
  const infos = (t.result && t.result.targetInfos) || [];
  return infos.filter((x) => x.type === 'page' && /servicewechat\.com\//.test(x.url));
}

async function waitForMiniapp(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let firstTry = true;

  while (Date.now() < deadline) {
    const pages = await findMiniappTargets();
    if (pages.length) return pages;

    if (firstTry) {
      console.log('还没检测到小程序。请在微信里打开目标小程序…');
      firstTry = false;
    }
    process.stdout.write('.');
    await sleep(2000);
  }
  return [];
}

// ---------- 提取 token ----------
async function extractFrom(page) {
  const at = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  session = at.result && at.result.sessionId;
  if (!session) return null;

  contexts.clear();
  await send('Runtime.enable', {}, true);
  await sleep(1500);

  for (const [id] of contexts) {
    // 逻辑层才有完整的 storage API
    const probe = await evaluate(
      'typeof wx === "object" && typeof wx.getStorageInfoSync === "function"',
      id
    );
    if (probe.ok !== true) continue;

    const info = await evaluate('JSON.stringify(wx.getStorageInfoSync())', id);
    if (typeof info.ok !== 'string') continue;

    let keys;
    try { keys = JSON.parse(info.ok).keys || []; } catch { continue; }
    if (!keys.length) continue;

    const dump = await evaluate(
      `(()=>{const o={};for(const k of wx.getStorageInfoSync().keys){try{o[k]=wx.getStorageSync(k)}catch(e){o[k]='<读取失败>'}}return JSON.stringify(o)})()`,
      id
    );
    if (typeof dump.ok !== 'string') continue;

    let data;
    try { data = JSON.parse(dump.ok); } catch { continue; }

    const tokenKey =
      keys.find((k) => k.toLowerCase() === 'token') ||
      keys.find((k) => /token|access_?token|auth/i.test(k));
    if (!tokenKey) continue;

    const token = data[tokenKey];
    if (typeof token !== 'string' || token.length < 8) continue;

    const appid = (page.url.match(/servicewechat\.com\/(wx[0-9a-f]+)/) || [])[1] || '未知';
    return { token, tokenKey, appid, data };
  }
  return null;
}

// ---------- 主流程 ----------
async function main() {
  await ensureServer();

  try {
    await connect();
  } catch (e) {
    console.error('连不上调试服务：' + e.message);
    process.exit(1);
  }

  console.log('已连接调试服务，正在查找小程序…\n');

  const pages = await waitForMiniapp(60000);
  if (!pages.length) {
    console.log('\n');
    console.error('等了 60 秒也没检测到小程序。可能原因：');
    console.error('  1. 小程序没打开 —— 在微信里打开它，然后重新运行本脚本');
    console.error('  2. 调试服务刚启动，但小程序是之前就开着的 —— 关掉小程序重新打开');
    console.error('  3. 微信版本与 WMPFDebugger 不兼容');
    process.exit(1);
  }
  console.log('\n');

  for (const page of pages) {
    const result = await extractFrom(page);
    if (!result) continue;

    const { token, tokenKey, appid, data } = result;

    console.log('='.repeat(64));
    console.log('  找到 Token');
    console.log('='.repeat(64));
    console.log('');
    console.log(token);
    console.log('');
    console.log('-'.repeat(64));
    console.log(`  小程序   ${appid}`);
    console.log(`  字段     ${tokenKey}`);
    console.log(`  长度     ${token.length} 字符`);
    if (data.userInfo && typeof data.userInfo === 'object') {
      const u = data.userInfo;
      const who = [u.studentName || u.nickName || u.name, u.studentId, u.schoolName]
        .filter(Boolean).join(' / ');
      if (who) console.log(`  账号     ${who}`);
    }
    console.log('-'.repeat(64));
    console.log('');
    console.log('把上面那串 token 完整复制粘贴到登录框即可。');
    console.log('');

    cleanup();
    process.exit(0);
  }

  console.error('找到了小程序，但没能从它里面读出 token。可能原因：');
  console.error('  1. 目标小程序还没登录（先在小程序里完成登录）');
  console.error('  2. 该小程序的 token 没有存在 storage 里');
  cleanup();
  process.exit(1);
}

main().catch((e) => {
  console.error('出错：' + e.message);
  cleanup();
  process.exit(1);
});
