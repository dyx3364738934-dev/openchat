/**
 * bridge.js — WeChat + OpenCode Agent Bridge
 *
 * Startup:
 *   1. Parse CLI args
 *   2. Load config
 *   3. QR login (if no saved token)
 *   4. Detect desktop OpenCode
 *   5. Long-poll WeChat messages
 *   6. Dispatch to OpenCode agent
 *   7. Send reply back to WeChat
 *
 * Usage:
 *   openchat                 Normal mode
 *   node bridge.js --login-only   Login only, skip main loop
 *   node bridge.js --no-log-window Skip separate log window
 *
 * Env vars (override config.json):
 *   WECHAT_TOKEN             WeChat bot token
 *   OP

NCODE_AGENT            Agent type (default: build)
 *   OP

NCODE_MODEL            Model (default: deepseek-v4-pro)
 */

import { getConfig, saveToken } from "./config.js";
import { logger } from "./logger.js";
import { wechatQrLogin } from "./wechat-auth.js";
import {
  getUpdates,
  sendMessage,
  getConfig as getWechatConfig,
  sendTyping,
  notifyStart,
  notifyStop,
  extractTextFromItemList,
  TypingStatus,
} from "./wechat-api.js";
import {
  checkHealth,
  startOpenCodeServer,
  stopOpenCodeServer,
  sendToAgent,
  resetSession,
} from "./opencode-client.js";
import { StreamingMarkdownFilter } from "./markdown-filter.js";
import {
  restoreContextTokens,
  setContextToken,
  getContextToken,
  saveGetUpdatesBuf,
  loadGetUpdatesBuf,
} from "./session-store.js";

// ======== Constants ========

const ACCOUNT_ID = "default";
const DEFAULT_LONG_POLL_MS = 35000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30000;
const RETRY_DELAY_MS = 2000;
const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_PAUSE_MS = 60 * 60 * 1000; // 1 小时
const WECHAT_TEXT_LIMIT = 4000; // 微信单条消息文字上限

// ======== CLI Args ========

function parseArgs() {
  const args = process.argv.slice(2);
  let manualToken = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--token" && i + 1 < args.length) {
      manualToken = args[i + 1];
      break;
    }
  }
  return {
    loginOnly: args.includes("--login-only"),
    noLogWindow: args.includes("--no-log-window"),
    noAutoStart: args.includes("--no-auto-start"),
    manualToken,
  };
}

// ======== Login ========

async function ensureLogin(args) {
  const config = getConfig();

  // 命令行传 token
  if (args.manualToken) {
    console.log("✅ 使用命令行传入的 token");
    saveToken(args.manualToken);
    return args.manualToken;
  }

  // 已有 token，直接使用
  if (config.wechatToken) {
    console.log("✅ 使用已保存的微信 token");
    logger.info("bridge", "使用已保存的 token 登录");
    return config.wechatToken;
  }

  // 没有 token，走 QR 扫码登录
  console.log("\n🔐 未找到微信 token，开始扫码登录...\n");
  logger.info("bridge", "开始 QR 扫码登录");

  const result = await wechatQrLogin({ baseUrl: config.wechatBaseUrl });

  // 保存 token
  saveToken(result.botToken);
  console.log(`\n✅ 登录成功！Bot ID: ${result.accountId}`);
  console.log(`   用户 ID: ${result.userId}\n`);
  logger.info("bridge", "QR 登录成功", {
    accountId: result.accountId,
    userId: result.userId,
  });

  return result.botToken;
}

// ======== Message Split ========

/**
 * 将长文本按微信消息限制分割
 * 尽量在换行处分割，避免截断代码块
 */
function splitLongText(text, limit = WECHAT_TEXT_LIMIT) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > limit) {
    // 在 limit 附近找最近的换行
    let splitAt = limit;
    const searchStart = Math.max(0, limit - 200);
    const nlIndex = remaining.lastIndexOf("\n", limit);
    if (nlIndex > searchStart) {
      splitAt = nlIndex + 1;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

// ======== / 命令系统 ========

/** 用户偏好（内存存储） */
const userPrefs = new Map(); // userId → { model?, agent? }
/** 命令上下文（交互式命令用） */
const cmdContext = new Map(); // userId → { cmd, data }

async function handleSlashCommand(raw, userId, { token, baseUrl, contextToken }) {
  const parts = raw.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  // 如果用户在交互模式中
  const ctx = cmdContext.get(userId);
  if (ctx && ctx.cmd === "model") {
    // /model 2  → 解析为选择序号 2
    const choice = (cmd === "model" && args[0]) ? args[0] : cmd;
    if (!isNaN(choice)) {
      const idx = parseInt(choice) - 1;
      if (idx >= 0 && idx < ctx.data.length) {
        const chosen = ctx.data[idx];
        userPrefs.set(userId, { ...userPrefs.get(userId), model: chosen.id });
        cmdContext.delete(userId);
        return `模型已切换为 ${chosen.id}\n(${chosen.name || chosen.id})`;
      }
      return `序号超出范围 (1-${ctx.data.length})，请重新输入`;
    }
    // 非数字 → 名称匹配
    const match = ctx.data.find(m => m.id === choice || m.name === choice || m.id.endsWith("/" + choice));
    if (match) {
      userPrefs.set(userId, { ...userPrefs.get(userId), model: match.id });
      cmdContext.delete(userId);
      return `模型已切换为 ${match.id}`;
    }
    return `未找到 "${choice}"，请重试 (/model 重新列表)`;
  }

  // 清除之前的交互上下文
  cmdContext.delete(userId);

  switch (cmd) {
    case "reset":
      resetSession(userId);
      return "会话已重置";

    case "status": {
      const pref = userPrefs.get(userId) || {};
      const model = pref.model || getConfig().opencodeModel || "deepseek-v4-pro";
      const agent = pref.agent || getConfig().opencodeAgent || "build";
      return `当前状态\n模型: ${model}\nAgent: ${agent}\n发送 /help 查看命令`;
    }

    case "model": {
      if (args[0]) {
        // 直接指定模型名
        if (!userPrefs.has(userId)) userPrefs.set(userId, {});
        userPrefs.get(userId).model = args[0];
        return `模型已切换为 ${args[0]}`;
      }
      // 无参数：列出可用模型
      const models = await fetchAvailableModels();
      if (models.length === 0) return "无法获取可用模型列表";
      cmdContext.set(userId, { cmd: "model", data: models });
      const list = models.map((m, i) => `${i + 1}. ${m.id}${m.name ? " (" + m.name + ")" : ""}`).join("\n");
      return `可用模型：\n${list}\n\n回复序号或模型名切换`;
    }

    case "agent": {
      if (!args[0]) return "用法: /agent <agent类型>\n例如: /agent build";
      if (!userPrefs.has(userId)) userPrefs.set(userId, {});
      userPrefs.get(userId).agent = args[0];
      return `Agent 已切换为 ${args[0]}`;
    }

    case "help":
      return [
        "可用命令：",
        "/reset  - 重置会话",
        "/status - 查看当前状态",
        "/model  - 列出并切换模型",
        "/model <名> - 直接切换模型",
        "/agent <类型> - 切换 agent",
        "/help - 显示此帮助",
      ].join("\n");

    default:
      return `未知命令: /${cmd}\n发送 /help 查看可用命令`;
  }
}

/** 从 OpenCode session 历史 + 当前配置获取实际可用模型 */
async function fetchAvailableModels() {
  const seen = new Set();

  // 1) 从当前可用的 session 列表中提取模型
  try {
    const auth = "Basic " + Buffer.from("opencode:" + (process.env["OP"+"ENCODE_SERVER_PASSWORD"] || "")).toString("base64");
    const port = await detectPortForModels();
    if (port) {
      const r = await fetch("http://127.0.0.1:" + port + "/session", {
        headers: { Authorization: auth }, signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const sessions = await r.json();
        for (const s of sessions) {
          if (s.model?.id) {
            const id = s.model.providerID ? s.model.providerID + "/" + s.model.id : s.model.id;
            if (!seen.has(id)) {
              seen.add(id);
            }
          }
        }
      }
    }
  } catch {}

  // 2) 当前默认模型
  const cfg = getConfig();
  const defaultModel = cfg.opencodeModel || "deepseek/deepseek-v4-pro";
  seen.add(defaultModel);

  // 3) OpenCode Zen
  seen.add("opencode/zen");

  return [...seen].map(id => {
    const [p, m] = id.includes("/") ? id.split("/") : ["opencode", id];
    return { id: p + "/" + m, name: m, provider: p };
  });
}

/** 获取端口用于查询 models */
async function detectPortForModels() {
  try {
    const { execSync } = await import("node:child_process");
    const ns = execSync("netstat -ano", { encoding: "utf-8", timeout: 5000, windowsHide: true });
    const pm = new Map();
    for (const m of ns.matchAll(/127\.0\.0\.1:(\d+)\s+.*LISTENING\s+(\d+)/g)) pm.set(parseInt(m[2]), parseInt(m[1]));
    const tl = execSync('tasklist /FI "IMAGENAME eq OpenCode.exe" /FO CSV /NH', { encoding: "utf-8", timeout: 5000, windowsHide: true });
    const ocs = new Set();
    for (const m of tl.matchAll(/"OpenCode\.exe","(\d+)"/g)) ocs.add(parseInt(m[1]));
    for (const [pid, port] of pm) if (ocs.has(pid)) return port;
  } catch {}
  return null;
}

// ======== 处理单条消息 ========

async function processOneMessage(msg, { token, baseUrl }) {
  const fromUserId = msg.from_user_id;
  if (!fromUserId) {
    logger.warn("bridge", "消息缺少 from_user_id，跳过");
    return;
  }

  // allowFrom 白名单检查
  const allowFrom = getConfig().allowFrom;
  if (allowFrom.length > 0 && !allowFrom.includes(fromUserId)) {
    logger.info("bridge", `用户不在白名单中，跳过`, { from: fromUserId });
    return;
  }

  const textBody = extractTextFromItemList(msg.item_list).trim();
  const contextToken = msg.context_token;

  // / 命令拦截
  if (textBody.startsWith("/")) {
    const reply = await handleSlashCommand(textBody, fromUserId, { token, baseUrl, contextToken });
    if (reply) {
      await sendMessage({ baseUrl, token, toUserId: fromUserId, text: reply, contextToken });
    }
    return;
  }

  logger.info("bridge", `📩 收到消息`, {
    from: fromUserId,
    textLen: textBody.length,
    hasContextToken: !!contextToken,
    itemTypes: msg.item_list?.map((i) => i.type).join(",") ?? "none",
  });

  // 空消息跳过
  if (!textBody.trim()) {
    logger.debug("bridge", "空消息，跳过");
    return;
  }

  // 保存 context_token（用于后续主动发消息）
  if (contextToken) {
    setContextToken(ACCOUNT_ID, fromUserId, contextToken);
  }

  // 尝试获取 typing_ticket 并发送"正在输入…"
  let typingTicket = null;
  try {
    const config = await getWechatConfig({
      baseUrl,
      token,
      ilinkUserId: fromUserId,
      contextToken,
    });
    typingTicket = config.typing_ticket;
    if (typingTicket) {
      await sendTyping({
        baseUrl,
        token,
        ilinkUserId: fromUserId,
        typingTicket,
        status: TypingStatus.TYPING,
      }).catch(() => {}); // 忽略 typing 错误
    }
  } catch (err) {
    logger.debug("bridge", "获取 typing_ticket 失败（非关键）", err);
  }

  const startTime = Date.now();

  try {
    // 调用 OpenCode agent（session 自动创建，model/agent 由 opencode-client 管理）
    logger.info("bridge", `🤖 调用 agent`, { from: fromUserId });
    const prefs = userPrefs.get(fromUserId) || {};
    const result = await sendToAgent(fromUserId, textBody, prefs);
    const aiMs = Date.now() - startTime;

    // Markdown 过滤
    const filter = new StreamingMarkdownFilter();
    const filtered = filter.feed(result.text) + filter.flush();

    // 分割长消息
    const chunks = splitLongText(filtered);
    logger.info("bridge", `发送回复`, { chunks: chunks.length });

    // 逐段发送
    for (let i = 0; i < chunks.length; i++) {
      await sendMessage({
        baseUrl,
        token,
        toUserId: fromUserId,
        text: chunks[i],
        contextToken,
      });
      // 段间稍作延迟，避免微信限流
      if (i < chunks.length - 1) {
        await sleep(500);
      }
    }

    console.log(`✅ 回复已发送 → ${fromUserId} (${aiMs}ms, ${chunks.length}段)`);
  } catch (err) {
    logger.error("bridge", "处理消息失败", err);
    console.error(`❌ 回复失败 → ${fromUserId}: ${err.message}`);

    // 发送错误提示给用户
    try {
      await sendMessage({
        baseUrl,
        token,
        toUserId: fromUserId,
        text: `⚠️ 抱歉，处理您的消息时出错了：${err.message.slice(0, 100)}`,
        contextToken,
      });
    } catch {
      // 连错误提示都发不出去就算了
    }
  } finally {
    // 取消"正在输入…"
    if (typingTicket) {
      await sendTyping({
        baseUrl,
        token,
        ilinkUserId: fromUserId,
        typingTicket,
        status: TypingStatus.CANCEL,
      }).catch(() => {});
    }
  }
}

// ======== 主循环 ========

async function mainLoop({ token, baseUrl }) {
  // 恢复持久化数据
  restoreContextTokens(ACCOUNT_ID);

  let getUpdatesBuf = loadGetUpdatesBuf(ACCOUNT_ID) ?? "";
  let longPollTimeoutMs = DEFAULT_LONG_POLL_MS;
  let consecutiveFailures = 0;
  let sessionPausedUntil = 0;

  // 通知微信：网关已启动
  try {
    const resp = await notifyStart({ baseUrl, token });
    logger.info("bridge", "notifyStart", resp);
  } catch (err) {
    logger.warn("bridge", "notifyStart 失败（非关键）", err);
  }

  console.log("\n🟢 桥接服务已启动，等待微信消息...\n");
  logger.info("bridge", "主循环开始", {
    baseUrl,
    pollTimeoutMs: longPollTimeoutMs,
    bufLen: getUpdatesBuf.length,
  });

  const abortController = new AbortController();

  // 优雅退出
  const shutdown = async (signal) => {
    console.log(`\n🛑 收到 ${signal}，正在关闭...`);
    logger.info("bridge", `收到 ${signal}，开始关闭`);
    abortController.abort();

    try {
      await notifyStop({ baseUrl, token });
      logger.info("bridge", "notifyStop 完成");
    } catch (err) {
      logger.warn("bridge", "notifyStop 失败", err);
    }

    stopOpenCodeServer();
    console.log("👋 桥接服务已关闭");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // === 主循环 ===
  while (!abortController.signal.aborted) {
    try {
      // 会话暂停检查
      if (sessionPausedUntil > Date.now()) {
        const remaining = Math.ceil((sessionPausedUntil - Date.now()) / 1000);
        logger.info("bridge", `会话暂停中，剩余 ${remaining}s`);
        await sleep(Math.min(remaining * 1000, 60000), abortController.signal);
        continue;
      }

      // 长轮询收消息
      const resp = await getUpdates({
        baseUrl,
        token,
        getUpdatesBuf,
        timeoutMs: longPollTimeoutMs,
      });

      // 服务端建议的超时时间
      if (resp.longpolling_timeout_ms > 0) {
        longPollTimeoutMs = resp.longpolling_timeout_ms;
      }

      // 检查错误
      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        // 会话过期
        if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
          sessionPausedUntil = Date.now() + SESSION_PAUSE_MS;
          logger.error("bridge", `会话过期 (errcode=${SESSION_EXPIRED_ERRCODE})，暂停 1 小时`);
          console.error(`⏸️  微信会话过期，暂停 60 分钟...`);
          consecutiveFailures = 0;
          continue;
        }

        // 其他 API 错误
        consecutiveFailures++;
        logger.error("bridge", `getUpdates API 错误`, {
          ret: resp.ret,
          errcode: resp.errcode,
          errmsg: resp.errmsg,
          failures: consecutiveFailures,
        });

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`❌ 连续 ${MAX_CONSECUTIVE_FAILURES} 次失败，等待 ${BACKOFF_DELAY_MS / 1000}s...`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortController.signal);
        } else {
          await sleep(RETRY_DELAY_MS, abortController.signal);
        }
        continue;
      }

      // 成功
      consecutiveFailures = 0;
      sessionPausedUntil = 0;

      // 保存同步游标
      if (resp.get_updates_buf) {
        saveGetUpdatesBuf(ACCOUNT_ID, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      // 处理每条消息
      const msgs = resp.msgs ?? [];
      if (msgs.length > 0) {
        logger.info("bridge", `收到 ${msgs.length} 条消息`);
      }

      for (const msg of msgs) {
        await processOneMessage(msg, { token, baseUrl });
      }
    } catch (err) {
      if (abortController.signal.aborted) break;

      consecutiveFailures++;
      logger.error("bridge", `主循环异常 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`, err);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`❌ 连续 ${MAX_CONSECUTIVE_FAILURES} 次异常，等待 ${BACKOFF_DELAY_MS / 1000}s...`);
        await sleep(BACKOFF_DELAY_MS, abortController.signal);
        consecutiveFailures = 0;
      } else {
        await sleep(RETRY_DELAY_MS, abortController.signal);
      }
    }
  }
}

// ======== 入口 ========

async function main() {
  const args = parseArgs();

  console.log("╔══════════════════════════════════════════╗");
  console.log("║        OpenChat — WeChat + OpenCode     ║");
  console.log("╚══════════════════════════════════════════╝\n");

  const config = getConfig();

  // 日志窗口
  if (!args.noLogWindow) {
    logger.openLogWindow();
  }

  logger.info("bridge", "桥接服务启动", {
    wechatBaseUrl: config.wechatBaseUrl,
    opencodeApi: config.opencodeApi,
    autoStart: config.opencodeAutoStart,
  });

  // 1. 登录
  const token = await ensureLogin(args);

  // 仅登录模式
  if (args.loginOnly) {
    console.log("✅ 登录完成（--login-only 模式，不进入消息循环）");
    logger.info("bridge", "登录模式退出");
    return;
  }

  // 2. 检查 / 启动 OpenCode server（不阻塞，挂了也能跑）
  const serverHealthy = await checkHealth();
  if (!serverHealthy) {
    console.warn("⚠️  OpenCode server 未连接，消息将报错直到恢复");
    console.warn("   请确保桌面版 OpenCode 已运行，或手动启动:");
    console.warn("   opencode serve --port 4096");
    logger.warn("bridge", "OpenCode 未连接，桥接继续运行（消息将报错）");
  } else {
    console.log("✅ OpenCode server 已就绪");
  }

  // 3. 进入主循环
  await mainLoop({ token, baseUrl: config.wechatBaseUrl });
}

// ======== 工具 ========

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      }, { once: true });
    }
  });
}

// ======== 启动 ========

main().catch((err) => {
  console.error("💥 致命错误:", err.message);
  logger.error("bridge", "致命错误", err);
  process.exit(1);
});
