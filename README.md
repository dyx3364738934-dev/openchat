# OpenChat v1.4.0

微信 ↔ OpenCode Agent 桥 —— 用微信消息控制你的 AI Agent。

## 安装

### 方法一：一键命令（推荐）

在 OpenCode 内置终端（Ctrl+`）里粘贴下面这一行：

```powershell
Set-Location "$HOME\Desktop"; Invoke-WebRequest "https://github.com/dyx3364738934-dev/openchat/archive/refs/heads/master.zip" -OutFile openchat.zip; Expand-Archive openchat.zip -DestinationPath . -Force; Remove-Item openchat.zip; Rename-Item openchat-master openchat -ErrorAction SilentlyContinue; Set-Location openchat; npm.cmd install; Copy-Item config.example.json config.json; Set-Content prompt.txt '你在微信环境里和用户聊天。回复要像微信消息一样简短自然。'; $p = (Get-Location).Path; [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $p, 'User'); node bridge.js
```

首次运行会弹二维码图片，用微信扫码登录。

之后任何时候在终端输入 `openchat` 即可启动。

### 方法二：手动安装

> 如果你已经有 git 并且 npm 能正常运行，也可以用 git：

```bash
git clone https://github.com/dyx3364738934-dev/openchat.git
cd openchat
npm install
copy config.example.json config.json
echo 你在微信环境里和用户聊天。回复要像微信消息一样简短自然。> prompt.txt
node bridge.js
```

### 常见安装问题

**npm 报 "禁止运行脚本" / PSSecurityException：**  
PowerShell 执行策略限制，改用 `npm.cmd` 代替 `npm`：

```powershell
npm.cmd install
```

**git 不是有效命令：**  
没装 git。用方法一（ZIP 下载）即可，不需要 git。

**Node.js 没装：**  
去 [nodejs.org](https://nodejs.org/) 下载 v18+ 安装。

---

## 前置条件

| 项目 | 说明 |
|------|------|
| 系统 | Windows 10 / 11 |
| Node.js | v18+（推荐 v20+） |
| 终端 | **必须**用 OpenCode 内置终端（`Ctrl+`\`），否则无法获取认证密钥 |
| OpenCode | 桌面版正在运行 |

> ⚠️ **openchat 只能在 OpenCode 内置终端运行**。  
> 原因：OpenCode 只在启动时注入 `OPENCODE_SERVER_PASSWORD` 环境变量到内置终端，  
> 外部 PowerShell / CMD 无法获取此密钥，桥接会报错退出。

---

## DIY 自定义

所有配置都可以通过 **环境变量** 或 **config.json** 修改，环境变量优先。

### 1. 系统提示词（AI 行为）

这是最核心的 DIY 入口。支持三种方式：

**方式 A：prompt.txt 文件（推荐）**

编辑项目根目录的 `prompt.txt`，告诉 AI 它在什么环境里聊天：

```
你在微信环境里和用户聊天。回复要像微信消息一样简短自然，别写长篇大论。
```

> `prompts/` 目录下提供了示例插件文件。  
> 关于 AI 人设的深度注入方案，详见 `docs/injection-prompt-v3.0.md`（OpenCode agent 配置参考）。

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

### 3. 白名单限制

只允许特定微信用户使用：

```json
{
  "allowFrom": ["user_id_1", "user_id_2"]
}
```

留空数组或不设置 = 允许所有人。

### 4. 完整 config.json 参考

把 `config.example.json` 复制为 `config.json` 后修改：

```json
{
  "wechatToken": "",
  "opencodeAgent": "build",
  "opencodeModel": "deepseek/deepseek-v4-pro",
  "opencodeSystemPromptFile": "prompt.txt",
  "allowFrom": []
}
```

| 字段 | 环境变量 | 默认值 | 说明 |
|------|----------|--------|------|
| `wechatToken` | `WECHAT_TOKEN` | 自动保存 | 微信机器人 token，扫码后自动填 |
| `opencodeModel` | `OPENCODE_MODEL` | `deepseek-v4-pro` | 默认模型 |
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
3. 当前模型不支持图片时，降级为文字描述 `[用户发送了一张图片]`

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

## 重置登录

换了微信？清除当前登录状态：

```powershell
openchat --reset
```

下次运行 `openchat` 时会弹出新二维码，扫码即可绑定新微信。

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
├── bridge.js             入口 + 主循环 + 暖机（398行）
├── opencode-client.js    OpenCode 桌面检测 + Session 管理 + 流式轮询
├── wechat-api.js         微信 HTTP 协议（8个端点）
├── wechat-auth.js        二维码登录流程
├── cdn.js                微信 CDN 图片下载 + AES 解密
├── markdown-filter.js    流式 Markdown → 纯文本过滤
├── config.js             配置管理（环境变量 + config.json）
├── session-store.js      Context Token + 同步缓冲持久化
├── logger.js             文件日志 + 可选日志窗口
├── src/                  核心逻辑模块
│   ├── constants.js      共享常量
│   ├── split.js          长文本智能分段
│   ├── models.js         模型探测 / 坏模型缓存 / 列表
│   ├── commands.js       / 命令系统 + 用户偏好状态
│   ├── messages.js       消息处理管线 + 媒体暂存
│   └── agent.js          AI 调用 + 错误翻译 + 流式发送
├── prompts/              AI 提示词插件
│   └── wechat-chat.txt   示例：微信简短聊天
├── docs/                 参考文档
│   └── injection-prompt-v3.0.md  OpenCode 人设注入方案文档
├── prompt.txt            系统提示词（可自由编辑）
├── config.example.json   配置模板
├── config.json           运行时配置（首次复制自模板）
└── openchat.bat          启动器
```

---

## Changelog

### v1.4.0

**架构重构:**
- bridge.js 从 1226 行拆分为 8 个模块（src/ 子目录，按职责分离）
- 命令、模型、消息、AI调用各自独立模块，无循环依赖
- 5 处代码冗余消除（netstat / model fetch / auth header / buildClientVersion / session key）

**Bug Fixes:**
- reply 提取现在支持 reasoning/thinking 类型 parts，解决 DeepSeek 复杂话题返回空回复
- /model 交互模式下序号不再被清除上下文
- sessions LRU 驱逐改为真 LRU（命中时移到 Map 末尾）
- 视觉模型自动切换已移除，改由用户手动 /model
- 纯文字 500 错误自动回退到默认模型并标记坏模型
- 启动欢迎消息改为可配置（welcomeEnabled），默认开启

**健壮性增强:**
- 轮询失败日志从 DEBUG 提升到 INFO（HTTP 状态码、role、异常均可见）
- onDelta 中 sendMessage 失败不再静默吞错
- 空 AI 回复时自动发送提示消息
- 暖机循环：启动后等待模型就绪再进入消息循环
- Ctrl+C 在暖机阶段可正常退出
- AI 回复内容前 200 字记录到日志（preview 字段）

**其他:**
- 系统提示词插件化（prompts/ 目录 + 多插件支持）
- 新增 docs/injection-prompt-v3.0.md：OpenCode 人设注入方案完整文档
- 清理 5 处死代码（桶文件、未使用导入、空函数等）

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
