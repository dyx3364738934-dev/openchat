/**
 * bin/openchat.js — openchat 启动器 (设想 2 PoC)
 *
 * 用法：
 *   $ openchat                    # 启动 openchat，自动启动 mimo serve + 微信桥
 *   $ openchat --port 14115       # 指定 mimo serve 端口
 *   $ openchat --no-server        # 不启动 mimo serve（假设已运行）
 *   $ openchat --login-only       # 只扫码登录，不进入消息循环
 *   $ openchat --reset            # 清除微信登录状态
 *
 * 与 v1.5.0 的关键差异：
 *   - 不依赖 opencode 桌面版
 *   - 不依赖 OPENCODE_SERVER_PASSWORD 环境变量注入
 *   - 自动启动 headless mimo/opencode serve
 *   - 任何终端都可运行（不仅 OpenCode 内置终端）
 *
 * 实现路径：
 *   1. 检测 mimo/opencode CLI
 *   2. 启动 headless server (mimo serve --port 14115)
 *   3. 微信登录（QR 扫码）
 *   4. 长轮询收消息
 *   5. 调用 agent (mimo serve /session/:id/message)
 *   6. 发回复到微信
 *   7. Ctrl+C 优雅关闭
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolvePath(__dirname, "..", "..");

// ============================================================
// 复用设想 1 的 SDK
// ============================================================

const sdkPath = join(ROOT, "设想1-openchat独立化", "lib", "openchat-sdk.js");
const sdkUrl = new URL(`file:///${sdkPath.replace(/\\/g, "/")}`).href;
const {
  detectAgentCli,
  bootstrapServer,
  resolveServeConfig,
  checkHealth,
  listModels,
  callAgent,
} = await import(sdkUrl);

// ============================================================
// 微信协议层（简化版，对齐 openchat 原实现）
// ============================================================

const WECHAT_BASE_URL = "https://ilinkai.weixin.qq.com";

class WeChatClient {
  constructor({ baseUrl = WECHAT_BASE_URL } = {}) {
    this.baseUrl = baseUrl;
    this.token = null;
    this.longPollTimeoutMs = 35000;
  }

  setToken(token) {
    this.token = token;
  }

  async getUpdates(getUpdatesBuf = "") {
    if (!this.token) throw new Error("未登录");
    const r = await fetch(`${this.baseUrl}/ilink/bot/getupdates`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ get_updates_buf: getUpdatesBuf, base_info: this._baseInfo() }),
      signal: AbortSignal.timeout(this.longPollTimeoutMs),
    });
    if (!r.ok) throw new Error(`getUpdates HTTP ${r.status}`);
    return await r.json();
  }

  async sendMessage({ toUserId, text, contextToken }) {
    if (!this.token) throw new Error("未登录");
    const clientId = Math.random().toString(16).slice(2, 18);
    const r = await fetch(`${this.baseUrl}/ilink/bot/sendmessage`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2, // BOT
          message_state: 2, // FINISH
          item_list: text ? [{ type: 1, text_item: { text } }] : [],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
        base_info: this._baseInfo(),
      }),
    });
    if (!r.ok) throw new Error(`sendMessage HTTP ${r.status}`);
    return { messageId: clientId };
  }

  _headers() {
    return {
      "Content-Type": "application/json",
      "AuthorizationType": "ilink_bot_token",
      "X-WECHAT-UIN": Buffer.from(String(Math.floor(Math.random() * 100000000) + 100000000)).toString("base64"),
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String(0x00020401), // 2.4.1
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  _baseInfo() {
    return {
      channel_version: "2.4.1",
      bot_agent: "openchat-cli/2.0.0-poc",
    };
  }
}

// ============================================================
// Token 存储
// ============================================================

const CONFIG_PATH = join(__dirname, "..", "config.json");

function loadToken() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")).wechatToken || null;
  } catch {
    return null;
  }
}

function saveToken(token) {
  let cfg = {};
  if (existsSync(CONFIG_PATH)) {
    try { cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); } catch {}
  }
  cfg.wechatToken = token;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ============================================================
// CLI 参数
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    port: args.includes("--port") ? parseInt(args[args.indexOf("--port") + 1]) : null,
    noServer: args.includes("--no-server"),
    loginOnly: args.includes("--login-only"),
    reset: args.includes("--reset"),
    help: args.includes("--help") || args.includes("-h"),
  };
}

function printHelp() {
  console.log(`
openchat — 微信 ↔ Agent 桥 (PoC v2)

用法:
  openchat [选项]

选项:
  --port <number>     指定 agent server 端口 (默认: mimo=14113, opencode=4096)
  --no-server         不启动 agent server (假设已运行)
  --login-only        只扫码登录，不进入消息循环
  --reset             清除微信登录状态
  --help, -h          显示帮助

与 v1.5.0 差异:
  ✓ 不依赖 opencode 桌面版
  ✓ 任何终端都可运行
  ✓ 自动启动 headless agent server (mimo/opencode)
  ✓ 自动抓免费模型 (7 个)

示例:
  $ openchat                      # 完整启动
  $ openchat --login-only         # 只登录
  $ openchat --reset              # 清除登录
`);
}

// ============================================================
// 主流程
// ============================================================

function extractText(itemList) {
  if (!Array.isArray(itemList)) return "";
  return itemList
    .filter((i) => i.type === 1 && i.text_item?.text)
    .map((i) => i.text_item.text)
    .join("\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }

  console.log("╔══════════════════════════════════════════╗");
  console.log("║   openchat CLI — 微信 ↔ Agent 桥 v2 PoC ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // 1. 检测 agent CLI
  const cli = detectAgentCli();
  if (!cli) {
    console.error("❌ 未找到 mimo 或 opencode CLI");
    console.error("  安装: npm install -g @mimo-ai/cli 或 npm install -g opencode-ai");
    process.exit(1);
  }
  console.log(`✓ Agent CLI: ${cli.name} ${cli.version} @ ${cli.path}\n`);

  // 2. 启动/连接 agent server
  let bootstrap;
  if (args.noServer) {
    console.log("[跳过] 启动 agent server (--no-server)");
    bootstrap = { cfg: resolveServeConfig({ port: args.port }), process: null, stop: () => {}, cli: cli.name };
  } else {
    console.log("[1/4] 启动 headless agent server...");
    bootstrap = await bootstrapServer({
      port: args.port,
      host: "127.0.0.1",
      silent: true,
    });
    console.log(`  ✓ ${bootstrap.cli} serve ready @ http://${bootstrap.cfg.host}:${bootstrap.cfg.port}\n`);
  }

  // 3. 列出模型
  console.log("[2/4] 检查免费模型...");
  const models = await listModels(bootstrap.cfg);
  const free = models.filter((m) => m.free);
  console.log(`  共 ${models.length} 个模型，免费 ${free.length} 个`);
  if (free.length === 0) {
    console.warn("  ⚠️ 没有免费模型，需要用户配置付费 API key");
  } else {
    console.log(`  默认使用: ${free[0].id}`);
  }
  console.log();

  // 4. 微信登录
  console.log("[3/4] 微信登录...");
  let token = args.reset ? null : loadToken();
  if (args.reset) {
    saveToken("");
    console.log("  ✓ 已清除登录状态");
  }

  const wechat = new WeChatClient();
  if (token) {
    wechat.setToken(token);
    console.log("  ✓ 使用已保存的 token");
  } else {
    console.log("  ⚠️ PoC 版本暂不实现 QR 扫码登录");
    console.log("  请用 v1.5.0 完成首次登录，或手动填 token 到 config.json");
    console.log("  Token 字段: wechatToken\n");
    bootstrap.stop();
    process.exit(0);
  }

  if (args.loginOnly) {
    console.log("✓ 登录完成（--login-only 模式）");
    bootstrap.stop();
    return;
  }

  // 5. 消息循环
  console.log("[4/4] 桥接微信消息到 agent...");
  console.log("  按 Ctrl+C 退出\n");

  let getUpdatesBuf = "";
  let shuttingDown = false;

  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n🛑 收到 ${sig}，关闭中...`);
    bootstrap.stop();
    console.log("👋 已关闭");
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  while (!shuttingDown) {
    try {
      const resp = await wechat.getUpdates(getUpdatesBuf);
      if (resp.get_updates_buf) getUpdatesBuf = resp.get_updates_buf;
      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        const uid = msg.from_user_id;
        const text = extractText(msg.item_list);
        if (!uid || !text) continue;
        console.log(`📩 ${uid}: ${text.slice(0, 80)}`);
        try {
          const result = await callAgent(uid, text, { model: free[0]?.id });
          await wechat.sendMessage({ toUserId: uid, text: result.text, contextToken: msg.context_token });
          console.log(`💬 回复 (${result.text.length} 字符)`);
        } catch (err) {
          console.error(`❌ agent 调用失败: ${err.message.slice(0, 200)}`);
          await wechat.sendMessage({
            toUserId: uid,
            text: `⚠️ 处理失败：${err.message.slice(0, 100)}`,
            contextToken: msg.context_token,
          }).catch(() => {});
        }
      }
    } catch (err) {
      if (shuttingDown) break;
      console.error(`❌ 主循环异常: ${err.message}`);
      await sleep(2000);
    }
  }
}

main().catch((err) => {
  console.error("💥 致命错误:", err.message);
  console.error(err.stack);
  process.exit(1);
});
