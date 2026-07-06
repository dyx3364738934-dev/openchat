# 设想 2 — 基于 mimo/opencode CLI 重构 openchat

> **核心结论**：✅ 成立。把 openchat 改成命令行启动器，自动管理 mimo/opencode serve 子进程 + 微信桥。
> **验证状态**：✅ `openchat.js --help` 跑通，完整流程（启动 server + 列模型 + 检测登录）成功。

---

## 1. 与 v1.5.0 的关键差异

| 维度 | v1.5.0 | 设想 2 PoC |
|---|---|---|
| opencode 桌面版 | 必须 | **不需要** |
| 鉴权 | `OPENCODE_SERVER_PASSWORD` 注入 | 无（用 mimo）/ 用户指定（用 opencode） |
| 启动方式 | `openchat`（桌面版注入环境） | `openchat`（任何终端） |
| Server 管理 | 桌面版自带 | 自动 spawn mimo serve 子进程 |
| 终端要求 | 必须 OpenCode 内置终端 | 任何终端 |

---

## 2. 文件结构

```
设想2-opencode集成/
├── README.md
├── package.json
├── bin/
│   └── openchat.js          # 启动器（已跑通 --help）
└── (config.json)             # 运行时生成
```

---

## 3. 用法

```bash
# 完整启动（默认 mimo 端口 14113）
$ openchat

# 指定端口
$ openchat --port 14115

# 不启动 agent server（假设外部已启动）
$ openchat --no-server

# 只扫码登录，不进入消息循环
$ openchat --login-only

# 清除登录状态
$ openchat --reset

# 帮助
$ openchat --help
```

---

## 4. 验证跑通

```bash
$ node bin/openchat.js --port 14116

╔══════════════════════════════════════════╗
║   openchat CLI — 微信 ↔ Agent 桥 v2 PoC ║
╚══════════════════════════════════════════╝

✓ Agent CLI: mimo 0.1.0 @ D:\nodejs\node-v20.11.0-win-x64\mimo.cmd

[1/4] 启动 headless agent server...
  ✓ mimo serve ready @ http://127.0.0.1:14116

[2/4] 检查免费模型...
  共 7 个模型，免费 7 个  默认使用: huoshan/glm-5.1

[3/4] 微信登录...
  ⚠️ PoC 版本暂不实现 QR 扫码登录
  请用 v1.5.0 完成首次登录，或手动填 token 到 config.json
```

---

## 5. 启动流程

```
openchat
   │
   ├── 1. 检测 mimo/opencode CLI
   │      → mimo 0.1.0 ✅
   │
   ├── 2. 启动 headless server (mimo serve --port 14115)
   │      → mimo serve ready ✅
   │
   ├── 3. 列出模型（确认免费可用）
   │      → 7 个免费模型 ✅
   │
   ├── 4. 微信登录
   │      → 加载 token 或引导扫码
   │
   └── 5. 消息循环（长轮询 → agent → 微信回复）
          → Ctrl+C 优雅关闭
```

---

## 6. 已知限制

- **PoC 不实现 QR 扫码登录**：复用 v1.5.0 的 wechat-auth.js 即可（设计已就绪）
- **PoC 不实现流式输出**：发完消息等完整返回，再发到微信
- **PoC 不支持图片**：发图片需要 cdn.js + multipart 上传
- **依赖 mimo CLI 已装**

---

## 7. 与原 openchat 复用的部分

| 模块 | 来源 |
|---|---|
| `WeChatClient` | 本 PoC 重写（简化版，保留 4 个核心端点） |
| `wechat-auth.js` | 复用 v1.5.0（QR 登录） |
| `cdn.js` | 复用 v1.5.0（图片下载解密） |
| `markdown-filter.js` | 复用 v1.5.0（流式 Markdown） |
| `config.js` | 复用 v1.5.0 |
| `session-store.js` | 复用 v1.5.0（context_token） |

**核心改动**：移除 `opencode-client.js` 依赖 → 改用设想 1 的 `openchat-sdk.js`（直接调 mimo/opencode serve）

---

## 8. 后续工作

- ⏳ 集成 `wechat-auth.js`（QR 登录）
- ⏳ 流式输出（基于 polling，每 2s 一次）
- ⏳ 图片支持
- ⏳ 错误友好提示（友好错误信息翻译）
- ⏳ 启动欢迎消息
- ⏳ `/model` `/reset` `/status` `/help` 命令
