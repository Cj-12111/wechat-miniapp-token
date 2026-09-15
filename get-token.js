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
 *
 * 用法：
 *   node get-token.js                        # 任意已打开的小程序
 *   node get-token.js --appid wx8e8598...    # 只认指定小程序
 *   node get-token.js --wait 120             # 等待秒数，默认 60
 */

const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');

let popupSeq = 0;

const CDP_PORT = Number(process.env.CDP_PORT || 62000);
const CDP_URL = `ws://127.0.0.1:${CDP_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 命令行参数 ----------
const argv = process.argv.slice(2);

function argValue(names) {
  for (let i = 0; i < argv.length; i++) {
    for (const n of names) {
      if (argv[i] === n) return argv[i + 1];
      if (argv[i].startsWith(n + '=')) return argv[i].slice(n.length + 1);
    }
  }
  return null;
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
微信小程序 Token 提取工具

用法：
  node get-token.js [选项]

选项：
  --appid <appid>   只认指定的小程序（不知道可以不加，默认认任意小程序）
  --wait <秒>       等待小程序的秒数，默认 60
  --stop-server     结束后台的调试服务后退出
  --help, -h        显示本帮助

示例：
  node get-token.js
  node get-token.js --appid wx8e8598deed63f9b1
  node get-token.js --stop-server

说明：
  自动拉起的调试服务会留在后台，这样下次运行不需要重开小程序。
  想关掉它用 --stop-server。
`);
  process.exit(0);
}

const FILTER_APPID = argValue(['--appid', '-a']) || process.env.APPID || null;
const WAIT_SECONDS = Number(argValue(['--wait', '-w']) || 60);
const STOP_SERVER = argv.includes('--stop-server');

// 按端口找到监听进程并结束它（用于 --stop-server）
function killByPort(port) {
  const { execSync } = require('child_process');
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        pids.add(parts[parts.length - 1]);
      }
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch (_) { /* 忽略 */ }
      }
      return pids.size;
    }
    execSync(`lsof -ti tcp:${port} | xargs -r kill -9`, { stdio: 'ignore' });
    return 1;
  } catch (_) {
    return 0;
  }
}

if (STOP_SERVER) {
  const n = killByPort(CDP_PORT);
  console.log(n ? `已结束调试服务（端口 ${CDP_PORT}）。` : `端口 ${CDP_PORT} 上没有正在运行的调试服务。`);
  process.exit(0);
}

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

  // detached + unref：让服务独立于本脚本存活，脚本退出后它继续跑
  const base = { cwd: dir, stdio: 'ignore', windowsHide: true, detached: true };

  let cmd, args, opts;
  if (fs.existsSync(binJs)) {
    cmd = process.execPath;
    args = [binJs, 'src/index.ts'];
    opts = { ...base };
  } else if (fs.existsSync(shim)) {
    cmd = shim;
    args = ['src/index.ts'];
    opts = { ...base, shell: true };
  } else {
    console.error('WMPFDebugger 的依赖没装好（找不到 ts-node）。');
    console.error('请先进它的目录执行：yarn install');
    process.exit(1);
  }

  console.log('调试服务未运行，正在自动启动…');
  spawnedServer = spawn(cmd, args, opts);
  spawnedServer.unref();
  spawnedServer.on('error', (e) => {
    console.error('启动调试服务失败：' + e.message);
    process.exit(1);
  });

  // 等服务起来（含 frida 注入，通常几秒）
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await isPortOpen(CDP_PORT)) {
      await sleep(2000); // 再等 frida 把钩子挂稳
      console.log('调试服务已启动（会留在后台，下次运行无需重开小程序）。');
      console.log('想关掉它：node get-token.js --stop-server\n');
      return;
    }
  }

  cleanup();
  console.error('调试服务启动超时。');
  console.error('请手动进 WMPFDebugger 目录执行：corepack yarn ts-node src/index.ts');
  console.error('看看报什么错再回来。');
  process.exit(1);
}

// 默认把自动拉起的服务留在后台：否则下次运行小程序又变成「服务启动前就开着」，
// 而 frida 只对服务启动后新开的小程序生效 —— 用户就得反复关掉重开小程序。
// 想关掉用 --stop-server。
function cleanup() {
  if (!STOP_SERVER) return;
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
function appidOf(url) {
  return (url.match(/servicewechat\.com\/(wx[0-9a-f]+)/) || [])[1] || null;
}

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
  // 只认带 appid 的页面。servicewechat.com 下还有 preload-NN 这类预加载页，
  // 它们不是真正运行的小程序，attach 上去求值会挂住。
  const pages = infos.filter(
    (x) => x.type === 'page' && /servicewechat\.com\/wx[0-9a-f]+\//.test(x.url)
  );
  if (!FILTER_APPID) return pages;
  return pages.filter((x) => appidOf(x.url) === FILTER_APPID);
}

/**
 * 弹一个 Windows 消息框。
 * 光在控制台打印提示容易被忽略——用户看到窗口没动静就走了，
 * 然后报"没检测到小程序"。弹窗能确保他看到。
 * 用 detached 异步弹，不阻塞下面的轮询。
 */
function popup(title, text) {
  if (process.platform !== 'win32') return;
  try {
    // 中文不能走命令行参数（编码会被破坏），所以：
    //   .ps1 脚本保持纯 ASCII，中文放 UTF-8 数据文件里传进去。
    const stamp = `${process.pid}_${++popupSeq}`;
    const dir = os.tmpdir();
    const ps1 = path.join(dir, `wxtoken_popup_${stamp}.ps1`);
    const msg = path.join(dir, `wxtoken_popup_${stamp}.txt`);

    fs.writeFileSync(ps1, [
      '$f = $args[0]',
      "$c = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8) -split \"`n\", 2",
      'Add-Type -AssemblyName PresentationFramework',
      '[System.Windows.MessageBox]::Show($c[1], $c[0]) | Out-Null',
    ].join('\r\n'), 'utf8');

    fs.writeFileSync(msg, `${title}\n${text}`, 'utf8');

    const child = spawn('powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1, msg],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();

    // 弹窗进程退出后清掉临时文件
    child.on('exit', () => {
      for (const f of [ps1, msg]) { try { fs.unlinkSync(f); } catch (_) { /* 忽略 */ } }
    });
  } catch (_) {
    /* 弹不出来不影响主流程，控制台提示还在 */
  }
}

function announceWaiting() {
  console.log('还没检测到小程序。\n');
  console.log('>>> 现在请在 PC 微信里打开你要提取 token 的那个小程序。');
  console.log('    · 打开后停留几秒，让页面加载完');
  console.log('    · 如果它已经开着，请先关掉再重新打开（重要）');
  if (FILTER_APPID) {
    console.log(`    · 本脚本只认 appid: ${FILTER_APPID}`);
  } else {
    console.log('    · 不确定是哪个？任意一个都行，脚本会自己找 token');
  }
  console.log('');

  popup('请打开微信小程序', [
    '现在需要你做一件事：',
    '',
    '1. 打开 PC 版微信',
    '2. 把要提取 token 的小程序【关掉再重新打开】',
    '3. 停在页面上，等这里自动出结果',
    '',
    '为什么要重开：调试服务只对启动之后新打开的小程序生效。',
    '如果你之前就开着它，必须先关掉重开，否则读不到。',
    '',
    '（本窗口可以先不管，点确定后去操作微信即可）',
  ].join('\n'));
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

    return { token, tokenKey, appid: appidOf(page.url) || '未知', data };
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

  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let announced = false;
  let sawMiniapp = false;
  let lastErr = null;
  let lastNudge = 0;
  const seenAppids = new Set();

  // 「等小程序出现」和「读它」放在同一个循环里：
  // 小程序刚打开时页面往往还没初始化完，attach 会失败，需要反复重试。
  while (Date.now() < deadline) {
    const pages = await findMiniappTargets();

    if (pages.length) {
      sawMiniapp = true;
      for (const page of pages) {
        const a = appidOf(page.url);
        if (a) seenAppids.add(a);
      }

      for (const page of pages) {
        let result = null;
        try {
          result = await extractFrom(page);
        } catch (e) {
          lastErr = e.message; // 这个 target 还没就绪，下一轮再试
          continue;
        }
        if (!result) continue;

        const { token, tokenKey, appid, data } = result;

        console.log('\n' + '='.repeat(64));
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
        process.exit(0);
      }
    } else if (!announced) {
      announceWaiting();
      announced = true;
      lastNudge = Date.now();
    } else if (Date.now() - lastNudge > 90000) {
      // 90 秒还没动静，再弹一次 —— 用户多半没注意到第一次的提示
      console.log('（还没检测到小程序，再次提醒）');
      popup('还没检测到小程序', [
        '请在 PC 版微信里打开目标小程序。',
        '',
        '如果它本来就开着，必须先【关掉再重新打开】，',
        '否则脚本读不到。',
        '',
        '打开后停在页面上等几秒即可，不用再操作这个窗口。',
      ].join('\n'));
      lastNudge = Date.now();
    }

    process.stdout.write('.');
    await sleep(2500);
  }

  console.log('\n');
  if (sawMiniapp) {
    console.error(`检测到了小程序，但 ${WAIT_SECONDS} 秒内始终没能读出 token。\n`);
    console.error('可能原因：');
    console.error('  1. 小程序还没登录 —— 先在它里面完成登录，再重跑本脚本');
    console.error('  2. token 没有存在 storage 里（有些小程序只放内存）');
    console.error('  3. 页面还没加载完 —— 多等一会儿，或加大 --wait');
    if (lastErr) console.error(`\n最后一次错误：${lastErr}`);
    if (seenAppids.size > 1) {
      console.error('\n本次检测到多个小程序，可以指定其中一个重试：');
      for (const a of seenAppids) console.error(`  --appid ${a}`);
    }
  } else {
    console.error(`等了 ${WAIT_SECONDS} 秒也没检测到小程序。\n`);
    console.error('请检查：');
    console.error('  1. 小程序到底开了没有 —— 要在 PC 版微信里打开，不是手机');
    console.error('  2. 小程序是不是"之前就开着" —— frida 只对调试服务启动后');
    console.error('     新打开的小程序生效，务必关掉重开一次');
    console.error('  3. 用了 --appid 的话，确认 appid 没写错');
    console.error('  4. 微信版本与 WMPFDebugger 是否兼容');
    console.error(`\n想多等一会儿可以加参数：node get-token.js --wait 180`);
  }
  process.exit(1);
}

main().catch((e) => {
  console.error('出错：' + e.message);
  cleanup();
  process.exit(1);
});
