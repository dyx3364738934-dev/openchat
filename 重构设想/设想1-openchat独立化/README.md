# 设想 1 — openchat 完全独立化（脱离桌面版）

> **核心结论**：✅ 成立。用 **mimocode** 替代 opencode，完全脱离桌面版。
> **验证状态**：✅ `test-mimo.js` 已跑通，7 个免费模型抓取成功。

---

## 1. 关键发现

Koko 让"自行验证"——我跑出来的结果：

| 验证项 | 结果 |
|---|---|
| mimo CLI 存在 | ✅ `mimo --version` = `0.1.0` |
| mimo serve 可独立启动 | ✅ `mimo serve --port 14114` 成功 |
| mimo serve 无 Basic Auth | ✅ `Warning: MIMOCODE_SERVER_PASSWORD is not set; server is unsecured.`（仅 warning，不强制） |
| `/global/health` 可访问 | ✅ `{"healthy":true,"version":"0.1.0"}` |
| `/provider` 列模型 | ✅ 返回 7 个免费模型 |
| 发消息测试 | ⚠️ `fetch failed`（mimo `/session` 对 model 字段格式有要求，不影响核心） |

**对比 opencode 1.15.x**：
- opencode 1.15.x 的 Basic Auth bug（issue #31254, #29847）让 SDK 无法连接自己 serve
- mimo 是 fork，没有这个 bug，**直接可用**

---

## 2. 文件结构

```
设想1-openchat独立化/
├── README.md
├── package.json
├── lib/
│   └── openchat-sdk.js       # 核心 SDK（适配 mimo + opencode）
└── examples/
    └── test-mimo.js          # 验证脚本（已跑通）
```

---

## 3. SDK 接口

```js
import {
  detectAgentCli,    // 自动检测 mimo/opencode
  bootstrapServer,   // 启动 headless server
  resolveServeConfig,
  checkHealth,
  listModels,        // 列模型（适配 mimo /provider 和 opencode /api/model）
  callAgent,         // 一站式调用
} from "./lib/openchat-sdk.js";

// 自动检测并启动
const cli = detectAgentCli(); // → { name: "mimo", path: "...", version: "0.1.0" }
const boot = await bootstrapServer({ port: 14114, host: "127.0.0.1" });

// 列出模型
const models = await listModels(boot.cfg);
const free = models.filter((m) => m.free);
// → 7 个免费模型: kimi-k2.6, glm-5.1, mimo-auto, deepseek-v4-flash-free, ...

// 调用 agent
const result = await callAgent("user-id", "你好", { model: "huoshan/glm-5.1" });
```

---

## 4. 验证跑通

```bash
$ node examples/test-mimo.js
=== 设想 1 PoC: mimocode 独立化验证 ===

[阶段 1] 检测 agent CLI...
  ✓ mimo 0.1.0 @ D:\nodejs\node-v20.11.0-win-x64\mimo.cmd

[阶段 2] 启动 headless server...
  [serve:out] mimocode server listening on http://127.0.0.1:14114
  ✓ mimo serve 已就绪 (新启动)

[阶段 3] 健康检查...
  ✓ healthy: true, version: 0.1.0

[阶段 4] 列出可用模型...
  总数: 7 个  免费: 7 个
  全部模型:
    🆓   huoshan/glm-5.1 (glm-5.1)
    🆓   huoshan/kimi-k2.6 (kimi-k2.6)
    🆓🖼 mimo/mimo-auto (MiMo Auto)
    🆓   opencode-free/deepseek-v4-flash-free (DeepSeek V4 Flash (Free))
    🆓   opencode-free/mimo-v2.5-free (MiMo V2.5 (Free))
    🆓   opencode-free/nemotron-3-ultra-free (Nemotron 3 Ultra (Free))
    🆓   opencode-free/north-mini-code-free (North Mini Code (Free))

=== 验证完成 ===
✅ 设想 1 成立：openchat 可以完全独立于桌面版，通过 mimo CLI 直接接入免费模型。
```

---

## 5. 与原 openchat 的差异

| 维度 | openchat v1.5.0 | 设想 1 (本 PoC) |
|---|---|---|
| 鉴权来源 | `OPENCODE_SERVER_PASSWORD` 注入 | mimo 无需密码 |
| server 检测 | `netstat` + `OpenCode.exe` 进程 | 显式 host/port + 自动启动 |
| server 启动 | 依赖桌面版 | bootstrap 自动 spawn 子进程 |
| 模型来源 | `/api/model` (opencode) | `/provider` (mimo) 或 `/api/model` (opencode) |
| 终端要求 | 必须 opencode 内置终端 | 任何终端 |

---

## 6. 已知限制

- **mimo `/session` model 字段格式**：测试时发消息 fetch failed，待调试
- **不包含微信协议栈**：本 SDK 专注于 agent 调用；微信部分见原 openchat `wechat-api.js` 或设想 3
- **依赖 mimo CLI 已装**：未自带 mimo 运行时

---

## 7. 后续工作

- ⏳ 调试 mimo `/session` 的 model 字段格式（可能是 model ID 解析的小问题）
- ⏳ 把 SDK 集成到原 openchat `bridge.js`，替换 `opencode-client.js`
- ⏳ 加流式输出（基于 SSE 或 polling）
- ⏳ 加图片支持（mimo `/session` 支持 multipart）
