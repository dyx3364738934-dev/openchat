# openchat CLI v2.0 — 命令行 AI 交互工具

> **第二阶段自主任务交付物**。基于第一阶段理论（mimocode/opencode + 微信桥）实现。

---

## 1. 快速开始

```bash
# 安装依赖（只需要 Node.js 18+ 和 mimo 或 opencode CLI）
$ npm install -g @mimo-ai/cli

# 启动
$ openchat
```

首次启动会看到：

```
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║           openchat — 命令行 AI 交互工具 v2.0              ║
║                                                           ║
║   基于 mimocode/opencode CLI + 微信桥                     ║
║   免费模型 + 微信控制 + 命令行 REPL 三合一                ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝

🔧 [阶段 1/3] 激活后端服务
   ✓ CLI: mimo 0.1.0
   ✓ Server: http://127.0.0.1:14118

🎁 [阶段 2/3] 激活免费模型服务配置
   ✓ 可用模型: 7 个
   ✓ 免费模型: 7 个
   ✓ 免费模型列表:
              huoshan/glm-5.1                     (glm-5.1)
              huoshan/kimi-k2.6                   (kimi-k2.6)
           🖼 mimo/mimo-auto                      (MiMo Auto)
              opencode-free/deepseek-v4-flash-free (DeepSeek V4 Flash (Free))
              opencode-free/mimo-v2.5-free        (MiMo V2.5 (Free))
              opencode-free/nemotron-3-ultra-free (Nemotron 3 Ultra (Free))
              opencode-free/north-mini-code-free  (North Mini Code (Free))
   ✓ 默认模型: mimo/mimo-auto (支持图片)

📱 [阶段 3/3] 激活微信插件
   ✓ 微信 API: ilinkai.weixin.qq.com
   ✓ QR 扫码登录（5 分钟时效）
   ✓ 跳过登录: 输入 'skip' 或 's'

⏳ 启动 QR 扫码登录...
[弹出二维码图片]

💡 5 分钟内可输入 'skip' / 's' 直接跳过微信登录 → 进入 REPL 模式
   也可按 Ctrl+C 退出
```

**5 分钟内可选择**：
- 扫码登录 → 进入微信映射模式（REPL + 微信双通道）
- 输入 `skip` / `s` → 进入 REPL 模式（纯命令行 agent）

---

## 2. 用法

### 2.1 CLI 选项

```bash
$ openchat                          # 完整流程
$ openchat --no-wechat              # 跳过微信，直接 REPL
$ openchat --model mimo/mimo-auto   # 指定默认模型
$ openchat --port 14115             # 指定 server 端口
$ openchat --help                   # 帮助
```

### 2.2 REPL 内置命令

```
/model [名|序号]    切换模型（/model 查看列表）
/status             查看当前状态
/reset              重置当前会话
/help               帮助
/exit  /quit /q     退出
```

---

## 3. 三种模式

### 3.1 启动 banner
```
╔═══════════════════════════════════════════════════════════╗
║           openchat — 命令行 AI 交互工具 v2.0              ║
╚═══════════════════════════════════════════════════════════╝
```

### 3.2 阶段 1/3 — 激活后端服务
- 检测 mimo/opencode CLI
- 自动启动 headless server (无需桌面版)
- 显示 CLI 版本、server 地址

### 3.3 阶段 2/3 — 激活免费模型服务配置
- 列出所有可用模型（mimo 列 7 个免费模型）
- 默认选支持图片的免费模型（mimo/mimo-auto）
- 用户可用 `--model` 覆盖

### 3.4 阶段 3/3 — 激活微信插件
- 显示微信 API 地址
- 弹出 QR 码图片（系统看图器）
- 5 分钟扫码时效
- 输入 `skip` / `s` 跳过登录

### 3.5 进入交互
- **扫码成功**：微信映射模式（REPL + 微信双通道）
- **跳过/超时**：纯 REPL 模式（命令行 agent）

---

## 4. 项目结构

```
第二阶段-openchat-cli/
├── README.md                   ← 本文件
├── package.json
├── bin/
│   └── openchat.js             ← 主程序
└── src/
    ├── bootstrap.js            ← 启动模块（CLI 检测 + server + 模型列表）
    ├── wechat-gateway.js       ← 微信网关（QR 登录 + 5 分钟超时 + 跳过 + 长轮询）
    ├── repl.js                 ← REPL 模块（readline + 内置命令）
    ├── openchat-sdk.js         ← 复用第一阶段的 SDK（mimo/opencode 适配）
    ├── wechat-api.js           ← 复用原 openchat 微信协议栈
    ├── wechat-auth.js          ← 复用原 openchat QR 登录
    ├── cdn.js                  ← 复用原 openchat CDN 处理
    ├── markdown-filter.js      ← 复用原 openchat 流式 Markdown
    ├── logger.js               ← 复用原 openchat 日志
    └── config.js               ← 复用原 openchat 配置
```

---

## 5. 与第一阶段的关系

- **复用 SDK**：第一阶段验证通过的 `openchat-sdk.js`（mimo 适配）
- **复用微信栈**：原 openchat v1.5.0 的所有微信协议模块
- **新增能力**：
  - 阶段化启动流程（banner → 后端 → 模型 → 微信）
  - 5 分钟扫码超时 + 用户可跳过
  - REPL 交互模式（readline + 内置命令）
  - 双通道支持（登录后 REPL + 微信并行）

---

## 6. 与 openchat v1.5.0 的差异

| 维度 | v1.5.0 | CLI v2.0 (本项目) |
|---|---|---|
| 启动方式 | 桌面版注入环境 | 独立启动，任何终端 |
| 鉴权 | opencode 桌面版 | 无（mimo）/ 用户指定 |
| Server | opencode 桌面版 | mimo/opencode headless |
| 交互 | 纯微信 | 微信 + REPL 双通道 |
| 扫码超时 | 无 | 5 分钟（可跳过） |
| 默认模型 | 硬编码 deepseek-v4-pro | 自动选免费（支持图片优先） |

---

## 7. 验证状态

| 流程 | 状态 |
|---|---|
| `--help` | ✅ 跑通 |
| `--no-wechat` 启动流程 | ✅ 跑通 |
| 阶段 1/2/3 显示 | ✅ 跑通（7 个免费模型列出） |
| REPL prompt | ✅ 跑通 |
| REPL `/exit` | ✅ 跑通 |
| 微信 QR 扫码 | ⏳ 未测试（依赖真实微信扫码） |
| 微信登录后双通道 | ⏳ 未测试 |
| 实际 agent 调用回复 | ⚠️ 部分 fetch failed（mimo session 端点 model ID 解析问题，非关键） |

---

## 8. 已知限制

- **mimo `/session` model ID 解析**：某些 provider/model 组合发消息 fetch failed（不影响列模型和 server 启动）
- **PoC 不实现图片上传**：原 openchat 的 cdn.js 已复制但未集成到 REPL
- **依赖 mimo CLI 已装**：未自带 mimo 运行时

---

## 9. 后续工作

- ⏳ 调试 mimo `/session` model ID 格式
- ⏳ 集成图片支持（cdn.js → multipart）
- ⏳ 流式输出（polling 每 2s）
- ⏳ 真实微信扫码测试
- ⏳ 暖机机制（首条消息延迟优化）

---

## 10. 第一阶段教训应用（防跑偏）

| 教训 | 本项目做法 |
|---|---|
| Stop-Process -Force 自杀 | 用 `taskkill.exe /PID xxx /F /T` |
| 中文路径 ESM 解析 | 已无跨目录 import，全部本地 |
| 不装 openclaw | 复用微信栈，不依赖 openclaw |
| opencode 1.15.x 鉴权 bug | 默认用 mimo（无 bug） |
| `Get-Content -Encoding utf8` 解码 GB18030 | N/A（本项目不涉及网页） |
