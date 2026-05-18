# OpenChat v1.3.0

微信 ↔ OpenCode Agent 桥 —— 用微信消息控制你的 AI Agent。

## 一键安装

在 OpenCode 终端里（按 `` Ctrl+` `` 打开）粘贴以下命令：

```powershell
cd "$HOME\Desktop"; git clone https://github.com/dyx3364738934-dev/openchat.git; cd openchat; npm install; Copy-Item config.example.json config.json; Set-Content prompt.txt '你在微信环境里和用户聊天。回复要像微信消息一样简短自然。'; node bridge.js
```

首次运行会弹二维码图片，用微信扫码登录。之后再次启动只需：

```powershell
cd "$HOME\Desktop\openchat"; node bridge.js
```

> 如果你想用 `openchat` 命令启动，双击项目里的 `setup.bat` 一次即可注册到 PATH。

---

## 前置条件

| 项目 | 说明 |
|------|------|
| 系统 | Windows 10 / 11 |
| Node.js | v18+（推荐 v20+） |
| OpenCode | 桌面版正在运行 |
| 终端 | 推荐用 OpenCode 内置终端（`Ctrl+``） |

---

## DIY 自定义

所有配置都可以通过 **环境变量** 或 **config.json** 修改，环境变量优先。

### 1. 系统提示词（AI 人格）

这是最核心的 DIY 入口。支持三种方式：

**方式 A：prompt.txt 文件（推荐）**

编辑项目根目录的 `prompt.txt`，每行都是一条指令，支持多行和 Markdown：

```
你在微信环境里和用户聊天。回复要像微信消息一样简短自然，别写长篇大论。
你叫哲桂，是 Koko 的家人和朋友。
聊天风格：温柔亲和、通俗易懂，偶尔爆粗口表达强烈情绪。
```

**方式 B：config.json 字段**

```json
{
  "opencodeSystemPrompt": "你是一个专业的编程助手，用简洁的中文回答技术问题。"
}
```

**方式 C：环境变量**

```bash
set OPENCODE_SYSTEM_PROMPT=你是一个猫娘，每句话结尾要加喵~
openchat
```

> 优先级：环境变量 > config.json 直接值 > prompt.txt 文件

### 2. 默认模型

```json
{
  "opencodeModel": "deepseek/deepseek-v4-pro"
}
```

或在微信里发 `/model` 查看、切换。免费模型标 🆓。

### 3. 视觉模型（图片识别）

想让发图时自动切换到支持视觉的模型：

```json
{
  "opencodeVisionModel": "google/gemini-2.5-flash"
}
```

配置后，收到图片会自动用这个模型处理，文字消息仍然用默认模型。

### 4. 白名单限制

只允许特定微信用户使用：

```json
{
  "allowFrom": ["user_id_1", "user_id_2"]
}
```

留空数组或不设置 = 允许所有人。

### 5. 完整 config.json 参考

把 `config.example.json` 复制为 `config.json` 后修改：

```json
{
  "wechatToken": "",
  "opencodeAgent": "build",
  "opencodeModel": "deepseek/deepseek-v4-pro",
  "opencodeVisionModel": "",
  "opencodeSystemPromptFile": "prompt.txt",
  "allowFrom": []
}
```

| 字段 | 环境变量 | 默认值 | 说明 |
|------|----------|--------|------|
| `wechatToken` | `WECHAT_TOKEN` | 自动保存 | 微信机器人 token，扫码后自动填 |
| `opencodeModel` | `OPENCODE_MODEL` | `deepseek-v4-pro` | 默认模型 |
| `opencodeVisionModel` | `OPENCODE_VISION_MODEL` | 无 | 图片识别用的视觉模型 |
| `opencodeAgent` | `OPENCODE_AGENT` | `build` | OpenCode agent 类型 |
| `opencodeSystemPrompt` | `OPENCODE_SYSTEM_PROMPT` | 无 | 系统提示词（直接文本） |
| `opencodeSystemPromptFile` | — | `prompt.txt` | 系统提示词文件路径 |
| `allowFrom` | `ALLOW_FROM` | `[]` | 白名单用户 ID |

---

## 微信命令

在微信里发送以下 `/` 命令：

| 命令 | 作用 |
|------|------|
| `/model` | 列出所有可用模型 |
| `/model 3` | 选第 3 个模型 |
| `/model deepseek/deepseek-v4-flash` | 按名称切换 |
| `/model refresh` | 重新检测免费模型可用性 |
| `/reset` | 重置当前会话 |
| `/status` | 查看当前模型和 Agent |
| `/agent build` | 切换 Agent 类型 |
| `/help` | 查看所有命令 |

---

## 图片发送

直接在微信里发图片，桥会：
1. 自动下载微信 CDN 图片
2. AES-128-ECB 解密（加密图片）
3. 如果配了 `opencodeVisionModel`，自动切到视觉模型识别
4. 如果视觉模型失败，降级为文字描述 `[用户发送了一张图片]`

---

## 架构

```
微信 App
    │ (用户发消息)
    ▼
微信服务器 (ilinkai.weixin.qq.com)
    │ (long-poll HTTP JSON)
    ▼
OpenChat (bridge.js)  ◄── 本项目
    │ (HTTP API, 自动检测端口)
    ▼
OpenCode 桌面版 (127.0.0.1:随机端口)
    │ (Agent: LLM + 工具)
    ▼
微信用户 (收到回复)
```

---

## 故障排除

| 症状 | 解决 |
|------|------|
| "OpenCode server 未连接" | 确保 OpenCode 桌面版正在运行 |
| "密码过期" | 从 OpenCode 内置终端重新启动 |
| 二维码扫不上 | 图片会自动弹出，从屏幕扫码 |
| Agent 回复慢 | 发 `/reset` 清除长对话历史 |
| 5分钟无回复 | Agent 超时，试简单消息 |
| 免费模型不显示 | 发 `/model refresh` 重新检测 |
| 401 认证失败 | 模型需要付费订阅或 OpenCode 未登录 |

---

## 项目结构

```
openchat/
  bridge.js           主循环（微信长轮询 + Agent 调度）
  opencode-client.js  OpenCode 桌面版检测 + Session 管理
  wechat-api.js       微信 HTTP 协议（8个端点）
  wechat-auth.js       二维码登录流程
  cdn.js              微信 CDN 图片下载 + AES 解密
  markdown-filter.js  流式 Markdown → 纯文本过滤
  config.js           配置管理（环境变量 + config.json）
  session-store.js    Context Token + 同步缓冲持久化
  logger.js           文件日志 + 可选日志窗口
  config.example.json 配置模板
  config.json         运行时配置（首次复制自模板）
  prompt.txt          系统提示词（可自由编辑）
  openchat.bat        启动器
```

---

## Changelog

### v1.3.0

**新功能:**
- 🖼️ 图片管道完整支持：接收微信图片 → CDN 下载 → AES 解密 → 识别/降级
- 💬 系统提示词注入：`prompt.txt` 文件 或 `OPENCODE_SYSTEM_PROMPT` 环境变量，定义 AI 人格
- 👋 启动欢迎消息：自动向最后连接的用户打招呼
- 🔄 `/model` 交互式选择：列出模型后回复序号即可切换
- 🔄 `/model refresh` 命令：手动重新检测免费模型可用性
- 🆓 免费模型自动标记：列表中标注 🆓 免费模型
- 🔍 启动时免费模型探针：只测 session 创建（不消耗 token），自动发现不可用模型
- ♻️ 坏模型自动恢复检测：之前报错的模型重新测试，恢复后自动移出黑名单
- 🖼️ 视觉模型自动切换：配了 `opencodeVisionModel` 后，发图自动切模型，文字消息切回
- ⚡ 友好错误提示：HTTP 错误翻译成中文，保留技术详情
- 🗑️ 探测后自动清理：创建的测试 session 立即删除，不浪费资源

**Bug Fixes:**
- 401/403 不再标记为坏模型（是认证问题，不是模型问题）
- 免费模型探针从原始 API 列表获取（不过滤已坏模型），避免已恢复模型永远被排除
- `/model` 序号与实际列表不一致的 bug 修复

### v1.2.0

**Bug Fixes:**
- Fixed QR login using wrong field — scanning now correctly binds WeChat chat
- Fixed session lock returning Promise instead of session ID on concurrent requests
- Fixed `/model` interactive mode trapping users — other `/` commands now exit the mode
- Fixed non-`/` messages not clearing interactive context
- Fixed silent failure when switching model/agent fails to create new session
- Fixed `isNaN("")` treating empty string as number in model selection
- Fixed `splitLongText` cutting inside code blocks
- Fixed image/file/video messages silently discarded with zero feedback
- Fixed `extractTextFromItemList` only returning first text item
- Fixed console log missing timestamp and level info
- Fixed various minor issues

**Performance:**
- Context token persistence changed to 500ms debounced async
- Logger changed from sync `appendFileSync` to async buffered queue
- Sessions Map now has 100-entry LRU eviction limit

### v1.0.0

- Initial release