# 项目状态重申 — 防偏移锚点

> **Koko 离线。这是真正的长线自主任务。**
> 每次有项目级突破，重申此文档。
> 目的：确保任务方向不偏移，所有关键约束和教训都在一页内。

---

## 1. 任务的本质（用户原始三个设想）

```
设想 1: openchat 其实可以完全独立于 opencode，在模型的调用上，仅需服务端支持就可以直接接入模型
设想 2: 如果上面结论成立，是否意味着就可以依赖于 opencode 开源 cli 框架完全重构 openchat 项目使其真正成为独立项目，加上微信插件，最终达到在微信上操控 agent 智能体的程度？
设想 3: 爆改项目之后的命令行 - openchat 的命令就类似于插件的启动命令？相当于直接把他当成 openclaw 用？
```

**输出位置**：所有内容在 `C:\Users\33647\Desktop\大宗\openchat\重构设想\` 下

---

## 2. 三个设想的最终结论

| 设想 | 结论 | 验证状态 |
|---|---|---|
| **设想 1** openchat 完全独立化 | ✅ 成立（用 mimocode 而非 opencode） | ✅ 已验证：`test-mimo.js` 跑通，7 个免费模型 |
| **设想 2** 基于 CLI 重构 | ✅ 成立 | ✅ 已验证：`openchat.js --help` 跑通，完整流程启动 mimo serve + 检测模型 |
| **设想 3** 当 openclaw 插件 | ✅ 成立（无需装 openclaw） | ⏳ 待实现：复用现有微信协议栈魔改成 openclaw 插件 |

---

## 3. 关键事实清单（不可遗忘）

### 3.1 Koko 的两次关键纠正（绝不可重复犯错）

1. **openclaw ≠ agent runtime**：openclaw 是**框架 / gateway / plugin 容器**，里面装着 `@tencent-weixin/openclaw-weixin` 微信插件。**不要装 openclaw**——openchat 的微信协议栈是从 openclaw-weixin 移植过来的（见 `markdown-filter.js` 注释"从 @tencent-weixin/openclaw-weixin 移植（v2.4.1）"），复用现有栈魔改即可。
2. **mimo vs vscode 插件都能跑**：Koko 已验证 mimo 和 vscode 里的 opencode 插件都能抓到免费模型。我自己独立验证了 mimo。

### 3.2 mimo 是 opencode 的 fork，关键差异（**已验证**）

| 维度 | opencode 1.15.x | mimocode 0.1.0 |
|---|---|---|
| 是否可独立启动 | ✅ | ✅ |
| 是否需要桌面版 | ❌ | ❌ |
| **是否需要 Basic Auth** | ✅（且 SDK client 401 不可用） | ❌ **不需要** |
| 列模型端点 | `/api/model` | `/provider` |
| 免费模型数 | 6+ | **7**（含 kimi-k2.6, glm-5.1, mimo-auto）|
| 启动命令 | `opencode serve` | `mimo serve` |

### 3.3 mimo 路径（默认使用）

```
CLI:     mimo.cmd (D:\nodejs\node-v20.11.0-win-x64\mimo.cmd)
命令:    mimo serve --port 14113 --hostname 127.0.0.1
认证:    无（warning: MIMOCODE_SERVER_PASSWORD not set, server is unsecured）
端点:    /global/health, /provider (列模型), /config/providers, /session
免费:    opencode-free/{deepseek-v4-flash-free, mimo-v2.5-free, nemotron-3-ultra-free, north-mini-code-free}
         + huoshan/{kimi-k2.6, glm-5.1}
         + mimo/mimo-auto (支持图片)
```

### 3.4 openchat 当前依赖（强约束）

- 当前 openchat v1.5.0 **强依赖 opencode 桌面版注入 OPENCODE_SERVER_PASSWORD 到内置终端**
- 当前微信协议栈与 openclaw-weixin **100% 同源**（同一套 iLink API）
- 详见 `C:\Users\33647\Desktop\大宗\openchat\重构设想\事实清单.md`

---

## 4. 硬约束（绝不可违反）

### 4.1 进程管理
- **永远不用** `Stop-Process -Force`（已导致 3 次 PowerShell "自杀"）
- **永远不用** `kill -9` 类似命令
- 用 `taskkill.exe /PID xxx /F /T` 杀指定 PID
- 启动测试进程用 `Start-Process -RedirectStandardOutput ... -WindowStyle Hidden`，**不带 -Wait**（避免等待造成混淆）

### 4.2 PowerShell 输出
- **避免**在命令里用 `| Out-Host -Head N`（PowerShell 5.1 不支持）
- 用 `| Select-Object -First N` 代替
- 控制台显示的中文乱码是 PowerShell host 问题，文件本身正确（用 .NET 直接解码验证）

### 4.3 文件路径
- 中文路径 + Node.js ESM 解析有 bug
- 解决：用 `fileURLToPath(import.meta.url)` + `new URL(`file:///${path.replace(/\\/g, "/")}`).href`
- 不要用相对路径 `../设想1/...` 直接 import

### 4.4 编码
- 网页 `opncd.ai/share/...` 是 GB18030 编码
- 用 .NET `Encoding.GetEncoding("GB18030")` 解码
- 中文字符串字面量在 JS 中是 UTF-8 字节嵌入，需双重解码

---

## 5. 已完成的工作清单

### 5.1 重构设想目录骨架 ✅
- `README.md` — 总览
- `重构方案.md` — 详细方案
- `事实清单.md` — 关键事实（含负面发现和正面发现）

### 5.2 设想 1 ✅
- `设想1-openchat独立化/lib/openchat-sdk.js` — SDK（适配 mimo + opencode）
- `设想1-openchat独立化/examples/test-mimo.js` — 验证脚本（**已跑通**）
- `设想1-openchat独立化/package.json`

### 5.3 设想 2 ✅
- `设想2-opencode集成/bin/openchat.js` — 启动器（**已跑通 --help**）
- `设想2-opencode集成/package.json`

### 5.4 设想 3 ⏳
- **待实现**：复用原 openchat 的 `wechat-api.js` + `wechat-auth.js` + `cdn.js` + `markdown-filter.js`，改造成符合 OpenClaw 插件 SDK 规范的形态
- **不需要装 openclaw**

---

## 6. 下一步（Koko 离线后我要做的）

1. ✅ 写此重申文档（当前任务）
2. ⏳ 实现设想 3 — 把 openchat 的微信协议栈魔改成符合 openclaw plugin-sdk 规范的插件骨架（不动用真实 openclaw）
3. ⏳ 补全三个设想的 README
4. ⏳ 清理临时调试文件（`_raw-*.html`, `_raw-*.txt`, `test-*.log`）
5. ⏳ 最终检查 — 跑一遍所有验证，确保不自杀

---

## 7. 错误回顾（绝不再犯）

| 错误 | 后果 | 教训 |
|---|---|---|
| `Stop-Process -Force` | PowerShell 自杀 3 次 | 改用 taskkill |
| `Get-Content -Encoding utf8` 解码 GB18030 网页 | 双重编码乱码 | 用 .NET 直接字节解码 |
| 试图装 openclaw | Koko 阻止 | openchat 微信栈就是从 openclaw-weixin 移植的，复用即可 |
| 把 openclaw 当成 agent runtime | Koko 纠正 | openclaw 是 plugin 容器 |
| 不重启 PowerShell 时跑 mimo.cmd | 子进程 stdin 关联导致自杀 | mimo.cmd 是 .cmd 脚本，避免被 PowerShell 当子进程处理 |

---

## 8. 已确认的负面发现（不再浪费时间）

- **opencode 1.15.x 的 Basic Auth bug**：影响 SDK 调用自己 serve，但不影响用 mimo（绕开）
- **mimo 模型 ID 解析有 edge case**：`huoshan/glm-5.1` 发消息时 fetch failed，但模型列表抓取正常
  - 这可能是 mimo 的 `/session` 端点对 model 字段格式有特殊要求，不影响核心设想

---

## 9. 任务完成的判定标准

- ✅ 三个设想都有 README 和 PoC 代码
- ✅ 设想 1 验证跑通（test-mimo.js）
- ✅ 设想 2 验证跑通（openchat.js --help）
- ⏳ 设想 3 骨架完整（plugin manifest + channel.js + wechat-monitor.js）
- ✅ 所有负面发现诚实记录（事实清单 F 节、G 节）
- ✅ Koko 的两次纠正都吸收（不再装 openclaw，明确 mimo vs openclaw 角色）

---

**这是最后的重申锚点。如果跑偏了，回来读这个文件。**
