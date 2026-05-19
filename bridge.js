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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getUpdates,
  sendMessage,
  getConfig as getWechatConfig,
  sendTyping,
  notifyStart,
  notifyStop,
  extractTextFromItemList,
  MessageItemType,
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
import { extractImageFromItems } from "./cdn.js";
import {
  restoreContextTokens,
  setContextToken,
  getContextToken,
  getAllContextTokens,
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
const PENDING_MEDIA_TIMEOUT_MS = 60_000; // 60 秒等待文字描述

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
 * 尽量在换行处分割，避免截断代码块（保持 ``` 配对）
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

    // 检查分割点前后是否在代码块内（未闭合的 ```）
    const beforeSplit = remaining.slice(0, splitAt);
    const fenceCount = (beforeSplit.match(/```/g) || []).length;
    // 奇数个 ``` 表示代码块未闭合，需要扩展到下一个闭合点
    if (fenceCount % 2 !== 0) {
      const closeIndex = remaining.indexOf("```", splitAt);
      if (closeIndex !== -1) {
        // 包含闭合 ``` 所在行的结尾
        const afterClose = remaining.indexOf("\n", closeIndex);
        splitAt = (afterClose !== -1 ? afterClose + 1 : closeIndex + 3);
      }
      // 找不到闭合点 → 不分割，看最终剩余是否超限（只能硬切）
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

/** 有效 / 命令列表（不含交互子命令） */
const VALID_COMMANDS = new Set(["reset", "status", "model", "agent", "help"]);

async function handleSlashCommand(raw, userId, { token, baseUrl, contextToken }) {
  const parts = raw.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  // 如果用户在交互模式中
  const ctx = cmdContext.get(userId);
  if (ctx && ctx.cmd === "model") {
    // 如果输入的是其他有效 / 命令（如 /help /reset），先退出交互模式再执行
    if (cmd !== "model" && VALID_COMMANDS.has(cmd)) {
      cmdContext.delete(userId);
      // 继续往下执行该命令
    } else if (cmd === "model" && !args[0]) {
      // 再次输入 /model（无参数）→ 重新列出模型列表
      cmdContext.delete(userId);
      // 继续往下执行 /model 命令
    } else {
      // /model 2  → 解析为选择序号 2
      const choice = (cmd === "model" && args[0]) ? args[0] : cmd;
      // 严格数字判断：排除空字符串和纯空格
      if (choice !== "" && !isNaN(Number(choice))) {
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
      return `未找到 "${choice}"，请重试 (/model 重新列表，或输入其他命令如 /help)`;
    }
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
      // /model refresh — 重新探测免费模型可用性
      if (args[0]?.toLowerCase() === "refresh") {
        cmdContext.delete(userId);
        try {
          const auth = "Basic " + Buffer.from("opencode:" + (process.env[OC_PREFIX + "SERVER_PASSWORD"] || "")).toString("base64");
          const port = await detectPortForModels();
          if (!port) return "无法检测 OpenCode 端口，请确保桌面应用正在运行";
          await probeFreeModels(port, auth);
          const models = await fetchAvailableModels();
          const freeCount = models.filter(m => m.free).length;
          return `刷新完成 ✅\n当前可用: ${models.length} 个模型 (其中 ${freeCount} 个免费)\n发送 /model 查看列表`;
        } catch (err) {
          return `刷新失败: ${err.message}`;
        }
      }
      // 无参数：列出可用模型，按供应商分组
      if (!args[0]) {
        const models = await fetchAvailableModels();
        if (models.length === 0) return "无法获取可用模型列表";
        const providerLabels = {
          opencode: "opencode (Zen)",
          deepseek: "deepseek",
          google: "google",
          "opencode-go": "opencode (Go)",
          openrouter: "openrouter",
        };
        const groups = new Map();
        for (const m of models) {
          const provider = m.provider || "other";
          if (!groups.has(provider)) groups.set(provider, []);
          groups.get(provider).push(m);
        }
        // 按显示顺序构建扁平列表，存入 cmdContext 供选择时用
        const displayOrder = [];
        const lines = [];
        let idx = 1;
        for (const [provider, groupModels] of groups) {
          const label = providerLabels[provider] || provider;
          lines.push(`${label}:`);
          for (const m of groupModels) {
            const shortName = m.id.includes("/") ? m.id.split("/").pop() : m.id;
            const freeTag = m.free ? " 🆓" : "";
            lines.push(`  ${idx}. ${shortName}${freeTag}`);
            displayOrder.push(m);
            idx++;
          }
        }
        cmdContext.set(userId, { cmd: "model", data: displayOrder });
        return `可用模型：\n${lines.join("\n")}\n\n回复序号或全名切换`;
      }
// 有参数：优先用缓存的模型列表（序号与显示一致），无缓存时只接受名称匹配
      const choice = args[0];
      // 先查缓存列表
      const cachedModels = cmdContext.get(userId)?.cmd === "model" ? cmdContext.get(userId).data : null;
      if (cachedModels && !isNaN(Number(choice))) {
        const idx = parseInt(choice) - 1;
        if (idx >= 0 && idx < cachedModels.length) {
          const chosen = cachedModels[idx];
          if (!userPrefs.has(userId)) userPrefs.set(userId, {});
          userPrefs.get(userId).model = chosen.id;
          cmdContext.delete(userId);
          return `模型已切换为 ${chosen.id}\n(${chosen.name || chosen.id})`;
        }
        return `序号超出范围 (1-${cachedModels.length})，/model 重新列表`;
      }
      // 无缓存时按名称匹配（不接受序号，因为序号与显示不一致）
      const models = await fetchAvailableModels();
      const match = models.find(m => m.id === choice || m.name === choice || m.id.endsWith("/" + choice));
      if (match) {
        if (!userPrefs.has(userId)) userPrefs.set(userId, {});
        userPrefs.get(userId).model = match.id;
        cmdContext.delete(userId);
        return `模型已切换为 ${match.id}`;
      }
return `未找到 "${choice}"，先 /model 看列表，再选序号或输入全名`;
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
        "/model refresh - 重新检测免费模型可用性",
        "/agent <类型> - 切换 agent",
        "/help - 显示此帮助",
      ].join("\n");

    default:
      return `未知命令: /${cmd}\n发送 /help 查看可用命令`;
  }
}

// ======== 坏模型持久化缓存 ========
const BROKEN_MODELS_FILE = resolve(import.meta.dirname || ".", "broken-models.json");

/** 从文件加载坏模型列表 */
function loadBrokenModels() {
  try {
    if (existsSync(BROKEN_MODELS_FILE)) {
      const data = JSON.parse(readFileSync(BROKEN_MODELS_FILE, "utf-8"));
      const set = new Set(data);
      if (set.size > 0) console.log(`📋 已加载 ${set.size} 个坏模型缓存`);
      return set;
    }
  } catch {}
  return new Set();
}

/** 保存坏模型列表到文件 */
function saveBrokenModels(set) {
  try {
    writeFileSync(BROKEN_MODELS_FILE, JSON.stringify([...set], null, 2), "utf-8");
  } catch (err) {
    logger.warn("bridge", "保存坏模型缓存失败", err.message);
  }
}

/** 标记模型为坏模型（运行时 500 时调用） */
function markBrokenModel(modelId) {
  const broken = loadBrokenModels();
  if (!broken.has(modelId)) {
    broken.add(modelId);
    saveBrokenModels(broken);
    logger.info("bridge", "🚫 模型标记为不可用并缓存", { model: modelId });
    console.log(`🚫 模型 ${modelId} 返回 500，已加入坏模型缓存`);
  }
}

/** 启动时快速验证免费模型可用性（只测 session 创建，不消耗 token） */
/**
 * 探测免费模型可用性（直接从 API 获取原始列表，包含 broken 模型）
 * 这样可以发现之前坏掉但现已恢复的模型，从 broken 列表中移除
 * 只测创建 session（不发消息），401/403 不标记为坏模型
 */
async function probeFreeModels(port, auth) {
  // 直接从 API 获取原始模型列表，不过滤 broken
  const rawModels = await fetchRawModels(port, auth);
  const freeModels = rawModels.filter(m => m.free);
  if (freeModels.length === 0) return;

  console.log(`🔍 正在验证 ${freeModels.length} 个免费模型可用性...`);
  const broken = loadBrokenModels();
  let okCount = 0, recoveredCount = 0, failCount = 0, authSkipCount = 0;

  for (const m of freeModels) {
    const modelId = m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id;
    const providerID = m.id.includes("/") ? m.id.split("/")[0] : "opencode";

    try {
      // 只测创建 session 能否成功（不发消息，不消耗 token）
      const s = await fetch("http://127.0.0.1:" + port + "/session", {
        method: "POST",
        headers: { Authorization: "Basic " + auth, "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "build", model: { id: modelId, providerID } }),
        signal: AbortSignal.timeout(5000),
      });
      if (s.ok) {
        const wasBroken = broken.has(m.id);
        if (wasBroken) {
          recoveredCount++;
          console.log(`  ♻️ ${m.id} — 已恢复！`);
        } else {
          okCount++;
          console.log(`  ✅ ${m.id}`);
        }
        broken.delete(m.id); // 从坏模型列表移除
        // 创建成功后立即删除 session，不浪费
        try {
          const session = await s.json();
          await fetch("http://127.0.0.1:" + port + "/session/" + encodeURIComponent(session.id), {
            method: "DELETE",
            headers: { Authorization: "Basic " + auth },
            signal: AbortSignal.timeout(3000),
          }).catch(() => {});
        } catch {}
      } else if (s.status === 401 || s.status === 403) {
        // 401/403 = 认证问题，不是模型本身的锅
        broken.delete(m.id); // 不标记为坏模型，让用户自己尝试
        authSkipCount++;
        console.log(`  ⏭️ ${m.id} — 认证受限 (${s.status})，跳过`);
      } else {
        // 500 等服务端错误 = 模型不可用
        broken.add(m.id);
        failCount++;
        console.log(`  🚫 ${m.id} — 不可用 (${s.status})`);
      }
    } catch (e) {
      // 超时或连接错误也标记为坏
      broken.add(m.id);
      failCount++;
      console.log(`  🚫 ${m.id} — 异常: ${e.message.slice(0, 50)}`);
    }
  }

  saveBrokenModels(broken);
  const total = okCount + recoveredCount + failCount + authSkipCount;
  console.log(`🔍 免费模型验证完成: ✅${okCount} ♻️${recoveredCount} 🚫${failCount} ⏭️${authSkipCount} / 共${total}个, 坏模型缓存: ${broken.size}个`);
}

/** 从 API 获取原始模型列表（不过滤 broken、不排除 embedding/tts） */
async function fetchRawModels(port, auth) {
  try {
    const r = await fetch("http://127.0.0.1:" + port + "/api/model", {
      headers: { Authorization: auth, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return [];
    const models = await r.json();
    if (!Array.isArray(models)) return [];
    return models.map(m => {
      const id = m.providerID + "/" + m.id;
      const isFree = (Array.isArray(m.cost) && m.cost.some(c => c.input === 0 && c.output === 0))
        || m.id.toLowerCase().includes(":free");
      return { id, name: m.name || m.id, provider: m.providerID, free: isFree };
    });
  } catch {
    return [];
  }
}

/** 从 OpenCode API 获取可用模型，动态拉取 + 持久化坏模型缓存 */
async function fetchAvailableModels() {
  const seen = new Map(); // id -> { id, name, provider, free?, hasImage? }

  // 从 OpenCode API 获取完整的模型列表
  try {
    const auth = "Basic " + Buffer.from("opencode:" + (process.env[OC_PREFIX + "SERVER_PASSWORD"] || "")).toString("base64");
    const port = await detectPortForModels();
    if (port) {
      const r = await fetch("http://127.0.0.1:" + port + "/api/model", {
        headers: { Authorization: auth, "Content-Type": "application/json" }, signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const models = await r.json();
        if (Array.isArray(models)) {
          for (const m of models) {
            const id = m.providerID + "/" + m.id;
            if (seen.has(id)) continue;
            const isFree = (Array.isArray(m.cost) && m.cost.some(c => c.input === 0 && c.output === 0))
              || m.id.toLowerCase().includes(":free");
            const hasImage = Array.isArray(m.capabilities?.input) && m.capabilities.input.includes("image");
            seen.set(id, { id, name: m.name || m.id, provider: m.providerID, free: isFree, hasImage });
          }
        }
      }
    }
  } catch (err) {
    logger.debug("bridge", "获取 API 模型列表失败", err.message);
  }

  // 确保默认模型在列表中
  const cfg = getConfig();
  const defaultModel = cfg.opencodeModel || "deepseek-v4-pro";
  const defaultId = defaultModel.includes("/") ? defaultModel : "deepseek/" + defaultModel;
  if (!seen.has(defaultId)) {
    seen.set(defaultId, { id: defaultId, name: defaultModel, provider: defaultModel.includes("/") ? defaultModel.split("/")[0] : "deepseek", free: false });
  }
  if (cfg.opencodeVisionModel && !seen.has(cfg.opencodeVisionModel)) {
    seen.set(cfg.opencodeVisionModel, { id: cfg.opencodeVisionModel, name: cfg.opencodeVisionModel, provider: cfg.opencodeVisionModel.split("/")[0], free: false, hasImage: true });
  }

  // 筛选：免费模型全部保留 + 付费模型只保留主力
  const paidAllowlist = new Set([
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-chat",
    "deepseek/deepseek-reasoner",
    "google/gemini-2.5-flash",
    "google/gemini-2.5-flash-lite",
    "google/gemini-2.5-pro",
    "google/gemini-3-flash-preview",
    "google/gemini-3.1-flash-lite",
    "google/gemini-3.1-flash-image-preview",
  ]);

  // 从持久化文件加载已知坏模型
  const brokenModels = loadBrokenModels();

  // 排除非聊天用途
  const skipKeywords = ["embedding", "tts", "live", "native-audio"];

  const candidates = [...seen.values()].filter(m => {
    if (brokenModels.has(m.id)) return false;
    const nameLower = (m.name || m.id).toLowerCase();
    for (const kw of skipKeywords) { if (nameLower.includes(kw)) return false; }
    // 付费模型只保留主力
    if (!m.free) return paidAllowlist.has(m.id);
    // 免费模型：只保留 opencode (Zen) 和 google (gemma)
    if (m.provider === "opencode" || m.provider === "google") return true;
    return false;
  });

  // 排序：免费优先
  const result = candidates.sort((a, b) => {
    if (a.free && !b.free) return -1;
    if (!a.free && b.free) return 1;
    return a.id.localeCompare(b.id);
  });
  return result;
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

// ======== 待发送媒体暂存 ========

/**
 * pendingMedia: userId → { parts, contextToken, timer }
 * 图片到达后暂存 60 秒，等文字拼合；超时则单独发送
 */
const pendingMedia = new Map();

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
    console.log(`📩 收到: ${textBody.slice(0, 80)}`);
    const reply = await handleSlashCommand(textBody, fromUserId, { token, baseUrl, contextToken });
    if (reply) {
      const preview = reply.slice(0, 60).replace(/\n/g, "\\n");
      console.log(`💬 回复: ${preview}${reply.length > 60 ? "..." : ""}`);
      await sendMessage({ baseUrl, token, toUserId: fromUserId, text: reply, contextToken });
    }
    return;
  }

  // 非 / 命令的普通消息：清除残留的交互上下文（如 /model 列表选择状态）
  if (cmdContext.has(fromUserId)) {
    cmdContext.delete(fromUserId);
  }

  console.log(`📩 收到: ${textBody.slice(0, 80)}${textBody.length > 80 ? "..." : ""}`);

  // ======== 媒体处理 ========

  const hasImage = msg.item_list?.some(i => i.type === MessageItemType.IMAGE) ?? false;
  const hasFile = msg.item_list?.some(i => i.type === MessageItemType.FILE) ?? false;
  const hasVideo = msg.item_list?.some(i => i.type === MessageItemType.VIDEO) ?? false;

  // 文件/视频暂不支持
  if (hasFile || hasVideo) {
    logger.info("bridge", "收到文件/视频消息，暂不支持", { from: fromUserId });
    await sendMessage({ baseUrl, token, toUserId: fromUserId, text: "暂不支持文件/视频消息，请发送文字或图片 😊", contextToken });
    return;
  }

  // 图片处理：下载 → 暂存 → 等文字 / 超时单独发送
  if (hasImage) {
    try {
      const imageData = await extractImageFromItems(msg.item_list);
      if (!imageData) {
        await sendMessage({ baseUrl, token, toUserId: fromUserId, text: "图片下载失败，请重试 😔", contextToken });
        return;
      }

      const mediaParts = [{ type: "file", mime: imageData.mime, url: imageData.dataUrl }];
      logger.info("bridge", "📷 图片已暂存", { from: fromUserId, sizeKB: Math.round(imageData.buffer.length / 1024), mime: imageData.mime });

      // 保存 context_token
      if (contextToken) {
        setContextToken(ACCOUNT_ID, fromUserId, contextToken);
      }

      // 如果同一条消息里有文字，立即合并发送
      if (textBody.trim()) {
        await sendToAgentWithReply(fromUserId, textBody, mediaParts, { token, baseUrl, contextToken });
        return;
      }

      // 只有图片，暂存等待文字
      if (pendingMedia.has(fromUserId)) {
        clearTimeout(pendingMedia.get(fromUserId).timer);
      }

      const timer = setTimeout(() => {
        const media = pendingMedia.get(fromUserId);
        if (!media) return;
        pendingMedia.delete(fromUserId);
        logger.debug("bridge", "图片超时，单独发送给 AI", { from: fromUserId });
        sendToAgentWithReply(fromUserId, "用户发送了一张图片", media.parts, { token, baseUrl, contextToken: media.contextToken })
          .catch(err => logger.error("bridge", "图片超时发送失败", err));
      }, PENDING_MEDIA_TIMEOUT_MS);

      pendingMedia.set(fromUserId, { parts: mediaParts, contextToken, timer });
      return;

    } catch (err) {
      logger.error("bridge", "图片处理失败", err);
      await sendMessage({ baseUrl, token, toUserId: fromUserId, text: `图片处理失败：${err.message.slice(0, 80)}`, contextToken });
      return;
    }
  }

  // ======== 纯文字消息 ========

  // 检查是否有暂存的图片等待合并
  if (textBody.trim() && pendingMedia.has(fromUserId)) {
    const media = pendingMedia.get(fromUserId);
    clearTimeout(media.timer);
    pendingMedia.delete(fromUserId);
    if (contextToken) {
      setContextToken(ACCOUNT_ID, fromUserId, contextToken);
    }
    logger.debug("bridge", "🖼️📝 文字+图片合并发送", { from: fromUserId });
    await sendToAgentWithReply(fromUserId, textBody, media.parts, { token, baseUrl, contextToken });
    return;
  }

  // 空文字且无媒体 → 跳过
  if (!textBody.trim()) {
    logger.debug("bridge", "空消息，跳过");
    return;
  }

  // 保存 context_token（用于后续主动发消息）
  if (contextToken) {
    setContextToken(ACCOUNT_ID, fromUserId, contextToken);
  }

  // 调用 agent 并回复（纯文字消息走这里）
  await sendToAgentWithReply(fromUserId, textBody, [], { token, baseUrl, contextToken });
}

// ======== 错误信息翻译 ========

/**
 * 把 OpenCode API 的技术错误翻译成用户友好但内行秒懂的消息
 * 保留 HTTP 状态码供技术人员排查
 */
function friendlyError(err, model) {
  const msg = err.message;
  const modelHint = model ? `（当前模型: ${model}）` : "";

  // HTTP 状态码映射
  if (/HTTP 400/i.test(msg)) {
    // 400: 请求格式错误（可能缺字段、data URL 无效等）
    const detail = /missing key/i.test(msg) ? "请求缺少必要字段" : "请求格式有误";
    return `请求被拒绝 — ${detail}${modelHint}\n技术详情: ${msg.slice(0, 200)}`;
  }
  if (/HTTP 401/i.test(msg)) {
    return `认证失败 — 请检查 OpenCode 服务是否正常运行${modelHint}\n技术详情: ${msg.slice(0, 200)}`;
  }
  if (/HTTP 402/i.test(msg)) {
    return `额度不足 — 该模型可能需要付费订阅${modelHint}\n技术详情: ${msg.slice(0, 200)}`;
  }
  if (/HTTP 429/i.test(msg)) {
    return `请求过于频繁 — 请稍后再试${modelHint}\n技术详情: ${msg.slice(0, 200)}`;
  }
  if (/HTTP 500/i.test(msg)) {
    // 500: 模型服务端错误（模型不可用、上游挂了等）
    if (/qwen.*3\.6|qwen3\.6/i.test(msg) || /qwen.*3\.6|qwen3\.6/i.test(model || "")) {
      return `Qwen 3.6 模型目前不可用 — 上游阿里云服务异常，这是 OpenCode 已知问题（#24088, #21455）\n建议用 /model 切换到其他模型${modelHint}`;
    }
    if (/free promotion has ended|免费/i.test(msg)) {
      return `该免费模型已结束免费期${modelHint}\n建议用 /model 切换到其他模型\n技术详情: ${msg.slice(0, 200)}`;
    }
    return `模型服务出错 — 服务端内部错误，可能是模型暂时不可用${modelHint}\n建议用 /model 切换模型后重试\n技术详情: ${msg.slice(0, 200)}`;
  }
  if (/HTTP 502|HTTP 503/i.test(msg)) {
    return `模型服务暂时不可用 — 请稍后重试${modelHint}\n技术详情: ${msg.slice(0, 200)}`;
  }
  if (/agent timeout/i.test(msg)) {
    return `模型响应超时（5分钟）— 可能是模型负载高或网络不稳${modelHint}\n建议用 /model 切换模型`;
  }
  if (/session create/i.test(msg)) {
    return `创建会话失败 — 可能是模型不可用或服务异常${modelHint}\n技术详情: ${msg.slice(0, 200)}`;
  }

  // 模型不支持图片
  if (/does not support|not support|cannot accept|no.*image|no.*vision|no.*multimodal|modalities/i.test(msg)) {
    return `当前模型不支持图片输入${modelHint}\n建议: 用 /model 切换到支持视觉的模型（如 gemini-2.5-flash）`;
  }

  // 兜底
  return `处理消息出错${modelHint}\n技术详情: ${msg.slice(0, 150)}`;
}

// ======== 调用 Agent 并回复 ========

/**
 * 统一的发消息 → 收回复 → 过滤 → 发送流程
 * 支持图片回退：如果模型返回 400 等错误（不支持图片），自动用文字描述重试
 */
async function sendToAgentWithReply(userId, text, mediaParts, { token, baseUrl, contextToken }) {
  // 尝试获取 typing_ticket 并发送"正在输入…"
  let typingTicket = null;
  try {
    const config = await getWechatConfig({
      baseUrl,
      token,
      ilinkUserId: userId,
      contextToken,
    });
    typingTicket = config.typing_ticket;
    if (typingTicket) {
      await sendTyping({
        baseUrl,
        token,
        ilinkUserId: userId,
        typingTicket,
        status: TypingStatus.TYPING,
      }).catch(() => {});
    }
  } catch (err) {
    logger.debug("bridge", "获取 typing_ticket 失败（非关键）", err);
  }

  const startTime = Date.now();

  try {
    // 调用 OpenCode agent（支持文字 + 媒体）
    const cfg = getConfig();
    const prefs = userPrefs.get(userId) || {};
    const currentModel = prefs.model || cfg.opencodeModel || "deepseek-v4-pro";
    // 有图片时，如果配置了视觉模型，自动切换
    const visionModel = cfg.opencodeVisionModel;
    const shouldSwitch = mediaParts.length > 0 && visionModel && visionModel !== currentModel;
    if (shouldSwitch) {
      logger.info("bridge", "📷 有图片，自动切换视觉模型", { from: currentModel, to: visionModel });
    }
    const activeModel = shouldSwitch ? visionModel : currentModel;
    const agentOpts = shouldSwitch ? { model: visionModel } : {};
    logger.debug("bridge", `🤖 调用 agent`, { from: userId, hasMedia: mediaParts.length > 0, model: activeModel, switched: shouldSwitch });
    const result = await sendToAgent(userId, text, { ...prefs, ...agentOpts }, mediaParts);
    const aiMs = Date.now() - startTime;

    // Markdown 过滤
    const filter = new StreamingMarkdownFilter();
    const filtered = filter.feed(result.text) + filter.flush();

    // 分割长消息
    const chunks = splitLongText(filtered);
    logger.debug("bridge", `发送回复`, { chunks: chunks.length });
    const preview = chunks[0].slice(0, 60).replace(/\n/g, "\\n");
    console.log(`💬 回复: ${preview}${chunks[0].length > 60 ? "..." : ""}`);

    // 逐段发送
    for (let i = 0; i < chunks.length; i++) {
      await sendMessage({
        baseUrl,
        token,
        toUserId: userId,
        text: chunks[i],
        contextToken,
      });
      if (i < chunks.length - 1) {
        await sleep(500);
      }
    }

    console.log(`✅ 回复已发送 → ${userId} (${aiMs}ms, ${chunks.length}段${mediaParts.length ? ", 📷" : ""})`);
  } catch (err) {
    logger.error("bridge", "处理消息失败", err);

    // 如果带图片发送失败，尝试降级为纯文字
    // 模型不支持图片、HTTP 400、视觉模型 500 等情况
    const isModelNotSupportImage = mediaParts.length > 0 && (
      /does not support|not support|cannot accept|no.*image|no.*vision|no.*multimodal|modalities|attachment.*not/i.test(err.message)
    );
    const isBadRequestWithMedia = mediaParts.length > 0 && /HTTP 400/i.test(err.message);
    const isServerErrWithMedia = mediaParts.length > 0 && /HTTP 5\d{2}/i.test(err.message);

    if (isModelNotSupportImage || isBadRequestWithMedia || isServerErrWithMedia) {
      logger.info("bridge", "图片发送失败，降级为文字描述", { from: userId, reason: isModelNotSupportImage ? "模型不支持图片" : isBadRequestWithMedia ? "HTTP 400" : "服务端错误", errMsg: err.message.slice(0, 200) });
      const fallbackText = text.trim()
        ? `[用户发送了一张图片]\n${text}`
        : "[用户发送了一张图片，但当前模型不支持识别图片]";
      try {
        const prefs = userPrefs.get(userId) || {};
        const retryResult = await sendToAgent(userId, fallbackText, prefs);
        const filter = new StreamingMarkdownFilter();
        const filtered = filter.feed(retryResult.text) + filter.flush();
        const chunks = splitLongText(filtered);
        for (let i = 0; i < chunks.length; i++) {
          await sendMessage({ baseUrl, token, toUserId: userId, text: chunks[i], contextToken });
          if (i < chunks.length - 1) await sleep(500);
        }
        console.log(`✅ 回复已发送（图片回退） → ${userId}`);
        return;
      } catch (retryErr) {
        logger.error("bridge", "图片回退重试也失败", retryErr);
      }
    }

    // 非图片的 500 错误：标记模型为坏模型，下次不再显示
    if (/HTTP 5\d{2}/i.test(err.message) && mediaParts.length === 0 && activeModel) {
      markBrokenModel(activeModel);
    }

    console.error(`❌ 回复失败 → ${userId}: ${err.message}`);

    try {
      const userMsg = friendlyError(err, activeModel);
      await sendMessage({
        baseUrl,
        token,
        toUserId: userId,
        text: `⚠️ ${userMsg}`,
        contextToken,
      });
    } catch {
      // 连错误提示都发不出去就算了
    }
  } finally {
    if (typingTicket) {
      await sendTyping({
        baseUrl,
        token,
        ilinkUserId: userId,
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

  const cfg = getConfig();
  console.log("\n🟢 桥接服务已启动，等待微信消息...\n");
  console.log(`   模型: ${cfg.opencodeModel || "deepseek-v4-pro(默认)"}`);
  if (cfg.opencodeVisionModel) console.log(`   视觉模型: ${cfg.opencodeVisionModel}`);
  const sp = getSystemPrompt();
  if (sp) console.log(`   系统提示词: ${sp.length} 字符`);

  // 启动时快速验证免费模型可用性（直接从 API 获取原始列表，包含 broken 模型以便发现恢复的）
  try {
    const auth = "Basic " + Buffer.from("opencode:" + (process.env[OC_PREFIX + "SERVER_PASSWORD"] || "")).toString("base64");
    const port = await detectPortForModels();
    if (port) {
      await probeFreeModels(port, auth);
    }
  } catch (err) {
    logger.warn("bridge", "免费模型验证失败（非关键）", err.message);
  }

  logger.info("bridge", "主循环开始", {
    baseUrl,
    pollTimeoutMs: longPollTimeoutMs,
    bufLen: getUpdatesBuf.length,
    model: cfg.opencodeModel || "deepseek-v4-pro",
    visionModel: cfg.opencodeVisionModel || "(未配置)",
    systemPrompt: sp ? `${sp.length} chars` : "(未配置)",
  });

  // 启动时主动打招呼：用系统提示词触发 AI 发送欢迎消息
  if (sp) {
    const savedUsers = getAllContextTokens(ACCOUNT_ID);
    if (savedUsers.length > 0) {
      // 只给最近一个用户发，避免广播骚扰
      const { userId: firstUser, token: ctxToken } = savedUsers[0];
      try {
        logger.info("bridge", "🎉 向已连接用户发送欢迎消息", { userId: firstUser });
        await sendToAgentWithReply(firstUser, "你好，我现在在微信和你聊天，有什么可以帮你的？", [], {
          token,
          baseUrl,
          contextToken: ctxToken,
        });
      } catch (err) {
        logger.warn("bridge", "欢迎消息发送失败（非关键）", { userId: firstUser, err: err.message });
      }
    } else {
      console.log("   （无已连接用户，跳过欢迎消息）");
    }
  }

  const abortController = new AbortController();
  let activeMessages = 0; // 正在处理的消息数
  let shuttingDown = false;

  // 优雅退出：等待正在处理的消息完成
  const shutdown = async (signal) => {
    console.log(`\n🛑 收到 ${signal}，正在关闭...`);
    logger.info("bridge", `收到 ${signal}，开始关闭`);
    shuttingDown = true;
    abortController.abort();

    // 等待正在处理的消息完成（最多 10 秒）
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
