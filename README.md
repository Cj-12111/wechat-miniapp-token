# 微信小程序 Token 提取工具

一个 Windows 下双击就能跑的小工具：把你**本机微信**里某个小程序存在 storage 中的 token 读出来。

典型用途是配合某些第三方前端登录——那些站点登录需要你从官方小程序里复制 token，但小程序本身没提供复制入口。

## 依赖

这一切的核心是 **[WMPFDebugger](https://github.com/evi0s/WMPFDebugger)**（作者 [@evi0s](https://github.com/evi0s)），一个微信小程序调试工具，**GPLv2 协议**。本脚本不包含它的任何代码，只是通过 WebSocket 连上它暴露的 CDP 代理读数据。**没有它这个脚本跑不起来**，请先去给原作者点个 star。

准备步骤：

1. 安装 [Node.js](https://nodejs.org/)（LTS 版即可）
2. 克隆并安装 WMPFDebugger：

   ```bash
   git clone https://github.com/evi0s/WMPFDebugger
   cd WMPFDebugger
   yarn install
   ```

   > 注意：必须用 `yarn`，**不要用 npm**。npm 会跳过 frida 的安装脚本，导致运行时
   > 报 `Cannot read properties of undefined (reading 'parameters')`。

3. 把 `WMPFDebugger` 目录放在本项目同级（`./WMPFDebugger`），或用环境变量指定路径：

   ```cmd
   set WMPF_DEBUGGER_DIR=D:\path\to\WMPFDebugger
   ```

## 用法

1. 在 PC 微信里**打开目标小程序，并确认已登录**
2. 双击 `获取Token.bat`

脚本会自动完成剩下的事：检测调试服务 → 没在跑就自己拉起来 → 等你打开小程序 → 找到 token 并打印。

> **重要**：如果调试服务是**刚刚**启动的，而小程序在那之前就开着，
> 请把小程序**关掉重新打开**。frida 只对服务启动之后新打开的小程序生效——
> 这是整个流程最反直觉的地方，也是失败率最高的原因。

### 命令行选项

```
node get-token.js [选项]

  --appid <appid>   只认指定的小程序（不加则认任意小程序）
  --wait <秒>       等待小程序的秒数，默认 60
  --stop-server     结束后台的调试服务后退出
  --help, -h        显示帮助
```

例如只认某个小程序、并多等一会儿：

```bash
node get-token.js --appid wx8e8598deed63f9b1 --wait 180
```

### 关于后台服务

自动拉起的调试服务**会留在后台**，这样下次运行不用重开小程序。
脚本检测到 62000 端口已有服务时会直接复用，不会重复启动。

用完想关掉：

```bash
node get-token.js --stop-server
```

输出形如：

```
================================================================
  找到 Token
================================================================

WXXCXaWBk8jTlHo+bKL2pS8zP+MAoqEoYwZj...

----------------------------------------------------------------
  小程序   wx8e8598deed63f9b1
  字段     token
  长度     101 字符
  账号     张三 / STU-20250001 / 某某大学
----------------------------------------------------------------
```

把 token 整段复制粘贴到目标站点的登录框即可。

## 工作原理

微信小程序是**双层架构**：

- **逻辑层** —— 跑业务 JS，发 `wx.request`，持有完整的 `wx.*` API 和 storage
- **视图层** —— WebView，负责渲染

WMPFDebugger 挂在视图层，所以直接在默认环境里求值 `wx` 会得到 `undefined`——**但 token 恰恰在逻辑层**。本脚本的做法是：

1. attach 到小程序的页面 target，拿到 session
2. 枚举 session 里的**全部执行上下文**（通常 6–8 个）
3. 逐个测 `typeof wx === "object" && typeof wx.getStorageInfoSync === "function"`
   —— worker 上下文里 `wx` 虽然是对象但没有 storage API，据此排除
4. 在命中的那个上下文里读全部 storage，按 `token` / `auth` 等关键字定位取值

## 常见问题

**「调试服务启动超时」**
手动进 WMPFDebugger 目录跑 `corepack yarn ts-node src/index.ts`，看报什么错。

**「等了 60 秒也没检测到小程序」**
两个高频原因：

1. 小程序没开 —— 在微信里打开它（必须是 **PC 版微信**，手机上的不算）
2. **小程序是调试服务启动之前就开着的** —— 把小程序关掉重新打开

还不行就用 `--wait 180` 多等一会儿。

**「检测到了小程序，但读不出 token」**
通常是页面还没加载完就挂了上去。脚本会在时限内反复重试，一般等一下就好；
如果一直不行，确认小程序里**已经登录**，或加大 `--wait`。

**某些小程序读不到**
只有 token 存在 storage 里才行。少数小程序把它留在内存或使用了加密存储，
这种情况本工具无能为力。

**`Error: [frida] version config not found: XXXXX`**
你的微信 WMPF 内核版本还没被 WMPFDebugger 适配。查一下
[支持列表](https://github.com/evi0s/WMPFDebugger)，或去提 issue。

**每次运行都要我重开小程序，很烦**
因为调试服务在重启后会重新注入，此前开着的小程序就"脱钩"了。
脚本已经把自动拉起的服务**留在后台**，所以正常只需要重开这一次；
之后反复运行都不用再动小程序。前提是别用 `--stop-server` 把它关掉。

**小程序一开就闪退**
大概率是全局/TUN 代理干扰（比如 yakit、Clash 的 TUN 模式）。把代理切成规则模式再试。

## 局限

- 只能读**本机微信当前登录账号**的 token——它读的是本地会话，拿不到别人的
- 只有 token 存在 storage 里才行；有些小程序把它留在内存里，那就读不到
- token 会过期，失效后回来重跑一次即可
- 仅 Windows（脚本里用了 `.bat`；不过 `get-token.js` 本身是跨平台的）

## 安全提醒

**token 等同于账号凭据。** 拿到它的人就能以你的身份操作对应系统里的所有功能。
把它交给你不了解的第三方站点之前，请自己想清楚——对方完全可以在你不知情的情况下
用你的账号做事。用完记得留意有效期，必要时在官方小程序里重新登录使其失效。

## 许可

MIT。详见 [LICENSE](LICENSE)。

核心依赖 [WMPFDebugger](https://github.com/evi0s/WMPFDebugger) 为 GPLv2，
版权归其作者 [@evi0s](https://github.com/evi0s) 所有。
