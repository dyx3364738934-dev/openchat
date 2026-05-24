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
 *   OPENCODE_AGENT           Agent type (default: build)
 *   OPENCODE_MODEL           Model (default: deepseek-v4-pro)
 */

import { getConfig, saveToken, getSystemPrompt, OC_PREFIX } from "./config.js";
import { logger } from "./logger.js";
import { wechatQrLogin } from "./wechat-auth.js";
import {
  getUpdates,
  sendMessage,
  notifyStart,
  notifyStop,
} from "./wechat-api.js";
import {
  checkHealth,
  stopOpenCodeServer,
  sendToAgent,
} from "./opencode-client.js";
import { StreamingMarkdownFilter } from "./markdown-filter.js";
import {
  restoreContextTokens,
  getAllContextTokens,
  saveGetUpdatesBuf,
  loadGetUpdatesBuf,
  clearAllContextTokens,
} from "./session-store.js";

// src/ 模块化导入
import { ACCOUNT_ID } from "./src/constants.js";
import { probeFreeModels } from "./src/models.js";
import { processOneMessage } from "./src/messages.js";

// ======== Constants ========

const DEFAULT_LONG_POLL_MS = 35000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30000;
const RETRY_DELAY_MS = 2000;
const SESSION_EXPIRED_ERRCODE = -14;

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
    resetToken: args.includes("--reset"),
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
  // 清除旧会话的 context token（重新登录后失效）
  clearAllContextTokens(ACCOUNT_ID);
  console.log(`\n✅ 登录成功！Bot ID: ${result.accountId}`);
  console.log(`   用户 ID: ${result.userId}\n`);
  logger.info("bridge", "QR 登录成功", {
    accountId: result.accountId,
    userId: result.userId,
  });

  return result.botToken;
}

// ======== 主循环 ========

async function mainLoop({ token, baseUrl }) {
  // 恢复持久化数据
  restoreContextTokens(ACCOUNT_ID);

  let getUpdatesBuf = loadGetUpdatesBuf(ACCOUNT_ID) ?? "";
  let longPollTimeoutMs = DEFAULT_LONG_POLL_MS;
  let consecutiveFailures = 0;

  // 通知微信：网关已启动
  try {
    const resp = await notifyStart({ baseUrl, token });
    logger.info("bridge", "notifyStart", resp);
  } catch (err) {
    logger.warn("bridge", "notifyStart 失败（非关键）", err);
  }

  const cfg = getConfig();
  console.log("\n🟢 桥接服务已启动，等待微信消息...\n");
  console.log(`   模型: ${cfg.opencodeModel || "deepseek-v4-pro(默认)"}`);
  const sp = getSystemPrompt();
  if (sp) console.log(`   系统提示词: ${sp.length} 字符`);

  // 启动时快速验证免费模型可用性（直接从 API 获取原始列表，包含 broken 模型以便发现恢复的）
  try {
    await probeFreeModels();
  } catch (err) {
    logger.warn("bridge", "免费模型验证失败（非关键）", err.message);
  }

  logger.info("bridge", "主循环开始", {
    baseUrl,
    pollTimeoutMs: longPollTimeoutMs,
    bufLen: getUpdatesBuf.length,
    model: cfg.opencodeModel || "deepseek-v4-pro",
    systemPrompt: sp ? `${sp.length} chars` : "(未配置)",
  });

  // 提前设置优雅退出，确保暖机阶段也能响应 Ctrl+C
  const abortController = new AbortController();
  let activeMessages = 0;
  let shuttingDown = false;

  const shutdown = async (signal) => {
    console.log(`\n🛑 收到 ${signal}，正在关闭...`);
    logger.info("bridge", `收到 ${signal}，开始关闭`);
    shuttingDown = true;
    abortController.abort();

    if (activeMessages > 0) {
      console.log(`⏳ 等待 ${activeMessages} 条消息处理完成...`);
      const deadline = Date.now() + 10000;
      while (activeMessages > 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

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

// 模型暖机：确保 OpenCode 模型就绪
  // 首次启动或重启时，模型可能冷启动导致前几条消息空回复
  if (sp) {
    const savedUsers = getAllContextTokens(ACCOUNT_ID);

    const maxRetries = 8;
    const retryDelayMs = 15_000;
    let warmedUp = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (abortController.signal.aborted) break;
      try {
        logger.info("bridge", `模型暖机 (${attempt}/${maxRetries})`);
        const result = await sendToAgent("_warmup_", "你好");
        const wf = new StreamingMarkdownFilter();
        const text = wf.feed(result.text) + wf.flush();

        if (text.trim()) {
          warmedUp = true;
          logger.info("bridge", `模型暖机完成 (第${attempt}次)`, { len: text.length, preview: text.slice(0, 200) });

          // 有历史用户时才发欢迎消息
          if (savedUsers.length > 0 && cfg.welcomeEnabled) {
            const { userId: firstUser, token: ctxToken } = savedUsers[0];
            await sendMessage({ baseUrl, token, toUserId: firstUser, text, contextToken: ctxToken });
          }
          break;
        }

        if (attempt < maxRetries) {
          console.log(`⏳ 模型暖机中... (${attempt}/${maxRetries})，${retryDelayMs / 1000}s 后重试`);
          await sleep(retryDelayMs, abortController.signal);
        }
      } catch (err) {
        logger.warn("bridge", `模型暖机失败 (${attempt}/${maxRetries})`, { err: err.message });
        if (attempt < maxRetries) await sleep(retryDelayMs, abortController.signal);
      }
    }

    if (!warmedUp) {
      logger.warn("bridge", "模型暖机未成功，首条消息可能延迟");
    }
  }

  // === 主循环 ===
  while (!abortController.signal.aborted) {
    try {
      // 长轮询收消息
      const resp = await getUpdates({
        baseUrl,
        token,
        getUpdatesBuf,
        timeoutMs: longPollTimeoutMs,
      });

      // 服务端建议的超时时间（含边界校验）
      const suggested = resp.longpolling_timeout_ms;
      if (suggested > 0) {
        longPollTimeoutMs = Math.max(10000, Math.min(120000, suggested));
      }

      // 检查错误
      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        // 会话过期（token 失效，例如在其他设备登录）
        if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
          logger.warn("bridge", `会话过期 (errcode=${SESSION_EXPIRED_ERRCODE})，token 已失效`);

          try {
            // 清掉旧 token
            saveToken("");
            logger.info("bridge", "旧 token 已清除");

            // 触发重新登录
            console.log("\n⚠️  微信会话已过期（可能在别处登录了），正在重新登录...\n");
            const result = await wechatQrLogin({ baseUrl });
            saveToken(result.botToken);
            console.log(`✅ 重新登录成功！新 Bot ID: ${result.accountId}`);
            logger.info("bridge", "重新登录成功", { accountId: result.accountId });
          } catch (loginErr) {
            console.error("❌ 重新登录失败:", loginErr.message);
            logger.error("bridge", "重新登录失败", loginErr);
          }

          console.log("\n🔄 请重新启动 openchat 以使用新 token\n");
          process.exit(0);
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

      // 保存同步游标
      if (resp.get_updates_buf) {
        saveGetUpdatesBuf(ACCOUNT_ID, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      // 处理每条消息
      const msgs = resp.msgs ?? [];
      if (msgs.length > 0) {
        logger.debug("bridge", `收到 ${msgs.length} 条消息`);
      }

      for (const msg of msgs) {
        if (shuttingDown) break;
        activeMessages++;
        try {
          await processOneMessage(msg, { token, baseUrl });
        } finally {
          activeMessages--;
        }
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

  // --reset: 清除已保存的微信 token，下次启动重新扫码
  if (args.resetToken) {
    saveToken("");
    clearAllContextTokens(ACCOUNT_ID);
    console.log("✅ 已清除微信登录状态和会话缓存");
    console.log("   重新运行 openchat 即可扫码登录新微信\n");
    process.exit(0);
  }

  console.log("╔══════════════════════════════════════════╗");
  console.log("║     OpenChat — WeChat + OpenCode       ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log("║  微信命令: /model /reset /status /help ║");
  console.log("║  终端: openchat --reset  清除登录     ║");
  console.log("╚══════════════════════════════════════════╝\n");

  const config = getConfig();

  // 检查是否在 OpenCode 内置终端运行
  if (!process.env[OC_PREFIX + "SERVER_PASSWORD"] && !process.env[OC_PREFIX + "PASSWORD"]) {
    console.error("⚠️  未检测到 OpenCode 认证密钥");
    console.error("   openchat 只能在 OpenCode 内置终端 (Ctrl+`) 运行");
    console.error("   OpenCode 只在启动时注入密钥到内置终端\n");
    process.exit(1);
  }

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
