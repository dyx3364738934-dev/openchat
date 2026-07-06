# OpenChat 重构设想 — 总览

> **本目录**：所有重构设想、可执行脚本、模拟命令、PoC 代码的统一收口位置。
> **目的**：把 openchat 从"opencode 桌面版的伴侣"改造成"独立可插拔的微信 ↔ Agent 桥"。
> **关联材料**：
> - 分享对话 `opncd.ai/share/Anch09tE`：标题 `mimocode 启动、定义及 opencode-桌面版配置差异`（关键事实来源）
> - 现有项目源码 `C:\Users\33647\Desktop\大宗\openchat\` (openchat v1.5.0)
> - 官方文档：`opencode.ai/docs/server/`, `opencode.ai/docs/cli/`, `docs.openclaw.ai/`

---

## TL;DR — 三个设想的最终结论

| 设想 | 结论 | 关键依据 |
|---|---|---|
| **设想 1** openchat 完全独立于 opencode，仅靠服务端接入模型 | ✅ 成立 | `opencode serve` 是 headless HTTP server，OpenAPI 3.1 spec 完整；`@opencode-ai/sdk` 是官方 Node SDK；`openchat` 当前实现就是 HTTP 客户端，可以无缝替换调用方式 |
| **设想 2** 依赖 opencode CLI 重构 openchat + 微信插件 → 微信操控 agent | ✅ 成立 | `opencode serve + run --attach` 模式专为外部客户端设计；opncd 对话已证明 vscode 插件走的就是这条路；openchat 微信协议完全可复用 |
| **设想 3** 爆改后的 `openchat` CLI 就是 openclaw 插件的启动命令 | ✅ 成立 | OpenClaw 是独立 agent runtime（不是 opencode），已有官方微信插件 `@tencent-weixin/openclaw-weixin`；openchat 的 `wechat-api.js` 与 openclaw 微信插件 API **100% 同源**（同一套 iLink 协议），只需把"调用 opencode HTTP"改成"调用 openclaw gateway"即可 |

**一句话总结**：openchat **不需要 opencode 桌面版**就能跑；可以基于 opencode 服务端模式独立化；也可以直接改造成 OpenClaw 插件，跟 OpenClaw 体系共生。三条路都通。

---

## 目录结构

```
重构设想/
├── README.md                       ← 本文件（总览）
├── 重构方案.md                     ← 详细技术方案
├── 事实清单.md                     ← 从 opncd 对话 + 官方文档提取的关键事实
├── 参考资料链接.md                 ← 所有引用过的 URL 汇总
│
├── 设想1-openchat独立化/           ← 设想 1 的 PoC
│   ├── README.md
│   ├── lib/
│   │   ├── openchat-sdk.js        ← 重写的 SDK（不依赖桌面版）
│   │   └── openchat-wechat.js     ← 微信协议封装（保留）
│   ├── examples/
│   │   └── standalone-demo.js     ← 不依赖 opencode 桌面的演示
│   └── package.json
│
├── 设想2-opencode集成/             ← 设想 2 的 PoC
│   ├── README.md
│   ├── bin/
│   │   ├── openchat.cmd           ← 启动器（包装 opencode serve + 桥）
│   │   └── openchat                ← *nix 启动器
│   ├── src/
│   │   ├── server-bootstrap.js    ← 启动 opencode serve
│   │   └── bridge.js              ← 桥接主循环（复用原 openchat 逻辑）
│   └── package.json
│
└── 设想3-openclaw插件/             ← 设想 3 的 PoC
    ├── README.md
    ├── openclaw.plugin.json        ← 插件清单
    ├── package.json
    ├── src/
    │   ├── channel.js             ← ChannelPlugin 实现
    │   └── wechat-monitor.js      ← 微信长轮询（复用 openchat 代码）
    └── README.md
```

---

## 快速开始（怎么读这个目录）

如果你想**验证设想是否成立**，先读：
1. `事实清单.md` — 从 opncd 对话提取的关键事实
2. `重构方案.md` — 详细技术方案与三个设想的实现路径

如果你想**跑 PoC**，按顺序：
1. `设想1-openchat独立化/` — 最小 PoC，验证 openchat 不需要桌面版
2. `设想2-opencode集成/` — 包装 opencode serve 的启动器
3. `设想3-openclaw插件/` — 改造成 OpenClaw 插件

---

## 关键依赖一览

| 组件 | 当前 openchat 依赖 | 重构后依赖 |
|---|---|---|
| opencode 桌面版 | ✅ 必须 | ❌ 可选 |
| OpenCode 服务端 (`opencode serve`) | ❌ 不需要 | ✅ 必需（设想 2） |
| `@opencode-ai/sdk` | ❌ 未用 | ✅ 设想 1/2 使用 |
| OpenClaw CLI | ❌ 未用 | ✅ 设想 3 使用 |
| `@tencent-weixin/openclaw-weixin` | ❌ 未用 | ✅ 设想 3 复用协议 |
| Node.js 18+ | ✅ | ✅ |

---

## 时间线

- **2026-05** openchat v1.5.0 当前形态（强依赖 opencode 桌面版）
- **2026-06-XX** 重构设想落地方案（本目录）
- **2026-XX-XX** 三个设想 PoC 验证
- **未来** 设想 3 → openchat 成为 OpenClaw 官方插件（终极形态）

---

## 安全与限制

- `OPENCODE_SERVER_PASSWORD` 是 opencode 的鉴权密码，**绝不**写入 config.json 或 git 仓库
- 微信 bot_token 同理
- 所有 PoC 默认使用环境变量 + 临时文件存储敏感信息
- 测试时使用 `127.0.0.1` 而非 `0.0.0.0`，避免暴露
