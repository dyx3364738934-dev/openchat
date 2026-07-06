# 设想 3 — openchat 改造成 OpenClaw 微信插件

> **核心结论**：openchat 改造成 OpenClaw 的微信 channel 插件，**不需要装 openclaw 本身**——openchat 的微信协议栈就是从 `openclaw-weixin` 移植过来的（见 `markdown-filter.js` 注释"从 @tencent-weixin/openclaw-weixin 移植（v2.4.1）"），复用即可。

---

## 1. 与 `@tencent-weixin/openclaw-weixin` 的关系

| 维度 | `openclaw-weixin` (官方) | `openchat-wechat` (本项目) |
|---|---|---|
| 维护方 | Tencent 官方 | 社区 (openchat 团队) |
| 微信协议 | iLink 官方 | 同源（移植自 openclaw-weixin） |
| 特性 | 轻量、稳定、生产级 | **流式 Markdown、坏模型缓存、暖机、typing 提示** 等 openchat 增强特性 |
| 用户群 | 稳定优先 | 尝鲜、喜欢丰富特性 |
| 安装 | `openclaw plugins install "@tencent-weixin/openclaw-weixin"` | `openclaw plugins install openchat-wechat` |

**两者并存**，用户可选装其一或都装。

---

## 2. 包结构

```
设想3-openclaw插件/
├── package.json              # npm 包定义，含 openclaw.channel 字段
├── config-schema.json        # openclaw 频道配置 JSON Schema
├── README.md                 # 本文件
└── src/
    ├── channel.js            # ChannelPlugin 实现
    └── wechat-monitor.js     # 微信长轮询监控器
```

---

## 3. 与 OpenClaw SDK 的对接

按 `openclaw/plugin-sdk/channel-core` 公开规范定义接口（不直接 import SDK）：

```js
// src/channel.js 导出
export const openchatWechatChannel = {
  id: "openchat-wechat",
  displayName: "WeChat (via OpenChat)",
  setup: { resolveAccount, inspectAccount, onFirstSetup },
  security: { dm: { ... } },
  pairing: { text: { ... } },
  thread: { topLevelReplyToMode: "reply" },
  outbound: { sendText },
  base: { sendMedia },
  messageStream: async function* (api) { ... }
};
```

实际运行时由 OpenClaw gateway 注入 `PluginApi`，本 PoC 不需要 openclaw 在场即可验证代码形态。

---

## 4. 复用的 openchat v1.5.0 模块

通过绝对路径直接 import（避免中文路径 ESM 解析问题）：

| 模块 | 作用 |
|---|---|
| `wechat-api.js` | iLink 8 个端点封装（getUpdates, sendMessage, getUploadUrl 等） |
| `wechat-auth.js` | QR 扫码登录 |
| `cdn.js` | 微信 CDN 图片下载 + AES-128-ECB 解密 |
| `markdown-filter.js` | 流式 Markdown → 微信纯文本过滤（**直接来自 openclaw-weixin 移植**） |
| `session-store.js` | context_token 持久化 |
| `config.js` | 配置管理 |

**关键**：所有模块都是 **100% 同源**（与 `openclaw-weixin` 同 API），不需要重写。

---

## 5. 与 OpenClaw 协作模式

```
┌─────────────────────────────────────┐
│  OpenClaw Gateway                   │
│  - Plugin loader                    │
│  - Channel registry                 │
│  - Message router                   │
│  - Agent dispatcher                 │
└─────────────────────────────────────┘
     │
     ├── plugin: @tencent-weixin/openclaw-weixin (官方)
     │
     └── plugin: openchat-wechat (本项目)  ◄── 我们在这里
           │
           ├── setup → resolveAccount + onFirstSetup (QR 登录)
           ├── messageStream → WeChatMonitor.pollMessages()
           ├── outbound → wechat-api.sendMessage()
           └── security → DM 白名单 (allowFrom)
```

---

## 6. 用户体验（最终形态）

```bash
# 安装插件
$ openclaw plugins install openchat-wechat
$ openclaw config set plugins.entries.openchat-wechat.enabled true

# 扫码登录
$ openclaw channels login --channel openchat-wechat
📱 二维码已弹出... ✅ 登录成功！

# 启动 gateway
$ openclaw gateway restart
[plugins] openchat-wechat loaded
[plugins] openclaw-weixin loaded
[channels] openchat-wechat: QR-scanned ✅
[gateway] listening on http://127.0.0.1:7777

# 微信用户发消息 → agent 处理 → 微信回复
```

---

## 7. PoC 状态

| 项 | 状态 |
|---|---|
| 插件 manifest (`package.json` + `config-schema.json`) | ✅ 完成 |
| ChannelPlugin 接口 (`src/channel.js`) | ✅ 完成 |
| 微信长轮询 (`src/wechat-monitor.js`) | ✅ 完成 |
| 配置解析 + DM 白名单 + 配对流程 | ✅ 完成 |
| 真正在 openclaw 里跑 | ⏳ 待真实环境验证 |

---

## 8. 与原 openchat 的差异

| 维度 | openchat v1.5.0 | openchat-wechat (插件) |
|---|---|---|
| 入口 | `bridge.js` | `src/channel.js` (export) |
| 主循环 | `bridge.js` 主进程 | OpenClaw gateway 调度 |
| agent 调用 | 直接 HTTP → opencode desktop | 由 OpenClaw 决定（opencode/mimo/其他） |
| 进程模型 | 单进程 | 多进程（OpenClaw gateway 是主进程） |
| 配置 | `config.json` | OpenClaw `openclaw.json` |

**关键差异**：openchat-wechat 不再绑定 opencode；它只是微信渠道，agent runtime 由 OpenClaw 选择。

---

## 9. 后续工作

- ⏳ 在真实 openclaw 环境（≥2026.3.22）验证插件加载
- ⏳ 复用 openchat 的暖机 / 坏模型缓存 / 流式 Markdown 等增强特性
- ⏳ 发布到 npm：`npm publish openchat-wechat`
- ⏳ CI 跟随 OpenClaw plugin-sdk 变更
