/**
 * opencode-client.js — OpenCode HTTP API 客户端
 * 仅从环境变量获取桌面版密码（OpenCode 内置终端自动注入）
 * 无其他密码来源，保持极简
 */
import { execSync } from "node:child_process";
import { logger } from "./logger.js";
import { getConfig, getSystemPrompt, OC_PREFIX } from "./config.js";

const OC = OC_PREFIX;

let _port = null;
let _auth = null;

// ============================================================
// 桌面检测
// ============================================================

async function detect() {
  if (_port && _auth) return { port: _port, auth: _auth };

  const password = process.env[OC + "SERVER_PASSWORD"];
  if (!password) return null;

  const username = process.env[OC + "SERVER_USERNAME"] || "opencode";
  const auth = Buffer.from(username + ":" + password).toString("base64");
  const h = { Authorization: "Basic " + auth };

  const tryPort = async (p) => {
    try {
      const r = await fetch("http://127.0.0.1:" + p + "/session", { headers: h, signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch { return false; }
  };

  // 1) env port
  const ep = parseInt(process.env[OC + "SERVER_PORT"]);
  if (ep > 0 && await tryPort(ep)) { _port = ep; _auth = auth; return { port: ep, auth }; }

  // 2) netstat 精确定位
  try {
    const ns = execSync("netstat -ano", { encoding: "utf-8", timeout: 8000, windowsHide: true });
    const pm = new Map();
    for (const m of ns.matchAll(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+.*LISTENING\s+(\d+)/gm)) pm.set(parseInt(m[2]), parseInt(m[1]));
    const tl = execSync('tasklist /FI "IMAGENAME eq OpenCode.exe" /FO CSV /NH', { encoding: "utf-8", timeout: 5000, windowsHide: true });
    const ocs = new Set();
    for (const m of tl.matchAll(/"OpenCode\.exe","(\d+)"/g)) ocs.add(parseInt(m[1]));
    for (const [pid, port] of pm) {
      if (ocs.has(pid) && await tryPort(port)) {
        _port = port; _auth = auth;
        logger.info("opencode", "desktop port " + port);
        return { port, auth };
      }
    }
  } catch (e) { logger.warn("opencode", "netstat fail: " + e.message); }

  return null;
}

// ============================================================
// HTTP 基础
// ============================================================

async function baseUrl() {
  const d = await detect();
  return d ? "http://127.0.0.1:" + d.port : getConfig().opencodeApi;
}

function headers() {
  if (_auth) return { "Content-Type": "application/json", Authorization: "Basic " + _auth };
  return { "Content-Type": "application/json" };
}

// ============================================================
// Session
// ============================================================

const MAX_SESSIONS = 100; // LRU 驱逐上限
const sessions = new Map(); // key: "userId:modelId" → sessionId
const locks = new Map();

/** 生成 session 缓存 key，包含模型信息以避免切换模型时覆盖 session */
function sessionKey(userId, model) {
  return `${userId}:${model || "default"}`;
}

async function getOrCreateSession(userId, model) {
  const key = sessionKey(userId, model);

  // 已有 session：先取出值，删旧 key，再重新 set（Map 会把 key 移到末尾，实现真 LRU）
  if (sessions.has(key)) {
    const sid = sessions.get(key);
    sessions.delete(key);
    sessions.set(key, sid);
    return sid;
  }

  // 如果另一个并发请求正在创建 session，等待它完成后取结果
  if (locks.has(key)) {
    await locks.get(key);
    // 等待完成后，创建方应该已经设置好了 sessions
    if (sessions.has(key)) return sessions.get(key);
    // 极端情况：创建方失败了，递归重试
    return getOrCreateSession(userId, model);
  }

  let resolveLock;
  const lock = new Promise(r => { resolveLock = r; });
  locks.set(key, lock);

  try {
    const base = await baseUrl();
    const h = headers();
    const cfg = getConfig();
    const mid = model || cfg.opencodeModel || "deepseek-v4-pro";
    const pid = mid.includes("/") ? mid.split("/")[0] : "deepseek";
    // API 的 model.id 不含 provider 前缀
    const modelId = mid.includes("/") ? mid.split("/").slice(1).join("/") : mid;

    const r = await fetch(base + "/session", {
      method: "POST", headers: h,
      body: JSON.stringify({ agent: cfg.opencodeAgent || "build", model: { id: modelId, providerID: pid } }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("session create HTTP " + r.status);

    const s = await r.json();
    sessions.set(key, s.id);
    // LRU 驱逐：超过上限时删除最旧的条目
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
      logger.info("opencode", "session LRU 驱逐", { evicted: oldest });
    }
    logger.info("opencode", "session created", { userId, model: mid, sid: s.id });
    return s.id;
  } finally {
    resolveLock();
    locks.delete(key);
  }
}

  // ============================================================
// 核心
// ============================================================

export async function resetSession(userId, model) {
  // 清除该用户的所有 session（不限模型）
  const prefix = `${userId}:`;
  for (const key of sessions.keys()) {
    if (key.startsWith(prefix) || key === userId) {
      sessions.delete(key);
    }
  }
}

/** 获取 OpenCode 桌面版端口号（复用 detect 的缓存结果） */
export async function getOpenCodePort() {
  const d = await detect();
  return d ? d.port : null;
}

/** 获取 OpenCode 桌面版认证 header（复用 detect 的缓存结果） */
export function getOpenCodeAuth() {
  if (_auth) return "Basic " + _auth;
  const password = process.env[OC_PREFIX + "SERVER_PASSWORD"];
  if (!password) return null;
  const username = process.env[OC_PREFIX + "SERVER_USERNAME"] || "opencode";
  return "Basic " + Buffer.from(username + ":" + password).toString("base64");
}

/**
 * 构建 parts 数组（文字 + 媒体）
 * @param {string} text - 文字内容
 * @param {Array<{type: string, mime?: string, filename?: string, url?: string}>} mediaParts - 媒体文件 parts
 * @returns {Array} parts 数组
 */
function buildParts(text, mediaParts) {
  const parts = [];
  if (text) {
    parts.push({ type: "text", text });
  }
  for (const mp of mediaParts) {
    // 验证 data URL 基本格式，避免发送无效数据
    if (!mp.url || !mp.url.startsWith("data:")) {
      logger.warn("opencode", "跳过无效的 mediaPart（url 非空且非 data: 格式）", { urlPrefix: (mp.url || "").slice(0, 30) });
      continue;
    }
    parts.push({
      type: "file",
      mime: mp.mime || "image/jpeg",
      ...(mp.filename ? { filename: mp.filename } : {}),
      url: mp.url,
    });
  }
  return parts;
}

export async function sendToAgent(userId, text, opts = {}, mediaParts = []) {
  const base = await baseUrl();
  const h = headers();
  const cfg = getConfig();

  // 确定要使用的模型
  const targetModel = opts.model || cfg.opencodeModel || "deepseek-v4-pro";
  const targetAgent = opts.agent || cfg.opencodeAgent || "build";

  // 用带模型信息的 key 获取或创建 session，切换模型不会覆盖之前的 session
  let sid;
  try {
    sid = await getOrCreateSession(userId, targetModel);
  } catch (err) {
    // session 创建失败，可能是模型不可用
    throw new Error(`创建 session 失败: ${err.message}`);
  }

  const esid = encodeURIComponent(sid);
  const parts = buildParts(text, mediaParts);
  const mediaInfo = mediaParts.map(m => ({ mime: m.mime, urlLen: (m.url || "").length }));
  logger.info("opencode", "send", { userId, sid, model: targetModel, textLen: text.length, mediaCount: mediaParts.length, media: mediaInfo, hasSystemPrompt: !!getSystemPrompt() });

  // 构建请求体，支持 system 提示词注入
  const systemPrompt = getSystemPrompt();
  const body = {
    parts,
    ...(systemPrompt ? { system: systemPrompt } : {}),
  };

  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 600_000); // 10 分钟超时

  try {
    const res = await fetch(base + "/session/" + esid + "/message", {
      method: "POST", headers: h,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(tm);

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if (res.status === 404) {
        // session 过期，清除缓存并重建
        const key = sessionKey(userId, targetModel);
        sessions.delete(key);
        logger.info("opencode", "session 过期，重建", { userId, model: targetModel, oldSid: sid });
        try {
          sid = await getOrCreateSession(userId, targetModel);
        } catch (retryErr) {
          throw new Error(`重建 session 失败: ${retryErr.message}`);
        }
        const r2 = await fetch(base + "/session/" + encodeURIComponent(sid) + "/message", {
          method: "POST", headers: h,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(600_000),
        });
        if (!r2.ok) {
          const retryBody = await r2.text().catch(() => "");
          throw new Error(`retry HTTP ${r2.status}: ${retryBody.slice(0, 300)}`);
        }
        const r2j = await r2.json();
        const t2 = (r2j.parts || []).filter(p => p.type === "text").map(p => p.text).join("");
        return { text: t2, parts: r2j.parts || [], info: r2j.info || null };
      }
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const result = await res.json();
    const reply = (result.parts || []).filter(p => p.type === "text").map(p => p.text).join("");
    logger.info("opencode", "reply ok", { sid, len: reply.length });
    return { text: reply, parts: result.parts || [], info: result.info || null };
  } catch (err) {
    clearTimeout(tm);
    if (err.name === "AbortError") throw new Error("agent timeout (10min)");
    throw err;
  }
}

/**
 * 流式发送消息到 agent：
 * 1. prompt_async 异步发送（立即返回 204）
 * 2. 监听 /global/event SSE，等待 session.idle 事件
 * 3. AI 完成后 GET 完整回复
 * 4. 失败时自动回退到同步 POST /message
 *
 * @param {string} userId - 用户 ID
 * @param {string} text - 文字内容
 * @param {object} opts - { model?, agent? }
 * @param {Array} mediaParts - 媒体文件
 * @param {object} streamOpts - { onDelta?: (text: string) => void, onProgress?: (elapsed: number) => void }
 */
export async function sendToAgentStreaming(userId, text, opts = {}, mediaParts = [], streamOpts = {}) {
  const base = await baseUrl();
  const h = headers();
  const cfg = getConfig();
  const targetModel = opts.model || cfg.opencodeModel || "deepseek-v4-pro";
  const targetAgent = opts.agent || cfg.opencodeAgent || "build";

  let sid;
  try {
    sid = await getOrCreateSession(userId, targetModel);
  } catch (err) {
    throw new Error(`创建 session 失败: ${err.message}`);
  }

  const esid = encodeURIComponent(sid);
  const parts = buildParts(text, mediaParts);
  const systemPrompt = getSystemPrompt();
  const body = {
    parts,
    ...(systemPrompt ? { system: systemPrompt } : {}),
  };

  // 尝试流式：SSE + prompt_async
  try {
    return await streamingRequest(base, h, sid, esid, body, streamOpts);
  } catch (streamErr) {
    logger.info("opencode", "SSE 流式失败，回退同步模式", { err: streamErr.message });
    // 回退到同步模式
    return await syncRequest(base, h, sid, esid, body);
  }
}

/**
 * 流式请求：prompt_async + SSE 监听
 */
async function streamingRequest(base, h, sid, esid, body, streamOpts) {
  const { onDelta, onProgress } = streamOpts;
  logger.info("opencode", "streaming request start", { sid });

  // 1. 先连接 SSE，避免错过早期事件
  let sseResponse;
  try {
    sseResponse = await fetch(base + "/global/event", {
      headers: { ...h, "Accept": "text/event-stream" },
      signal: AbortSignal.timeout(600_000), // 10 分钟
    });
    if (!sseResponse.ok || !sseResponse.body) {
      throw new Error(`SSE 连接失败: HTTP ${sseResponse.status}`);
    }
  } catch (err) {
    throw new Error(`SSE 连接失败: ${err.message}`);
  }

  // 2. 异步发送消息
  const promptRes = await fetch(base + "/session/" + esid + "/prompt_async", {
    method: "POST", headers: h,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  // prompt_async 成功返回 204，有些版本可能返回 200
  if (promptRes.status !== 204 && promptRes.status !== 200) {
    const errText = await promptRes.text().catch(() => "");
    // SSE 连接不要了
    try { await sseResponse.body.cancel(); } catch {}
    throw new Error(`prompt_async 失败: HTTP ${promptRes.status} ${errText.slice(0, 200)}`);
  }
  logger.info("opencode", "prompt_async sent", { sid });

  // 3. 读取 SSE 流，等待 session.idle
  let fullText = "";
  let lastProgressTime = Date.now();
  let done = false;
  const reader = sseResponse.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";

  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;

      sseBuffer += decoder.decode(value, { stream: true });

      // SSE 格式：每条事件由 \n\n 分隔，每行 data: {...}
      const events = sseBuffer.split("\n\n");
      sseBuffer = events.pop(); // 保留最后不完整的块

      for (const event of events) {
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const jsonStr = line.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const evt = JSON.parse(jsonStr);

            // 增量文本：累加到 fullText
            if (evt.type === "message.part.delta" && evt.properties?.sessionID === sid) {
              const delta = evt.properties?.delta || "";
              if (delta) {
                fullText += delta;
                if (onDelta) onDelta(delta);
              }
            }

            // session.idle = AI 完成
            if (evt.type === "session.idle" && evt.properties?.sessionID === sid) {
              logger.info("opencode", "SSE: session.idle received", { sid, textLen: fullText.length });
              done = true;
              break;
            }

            // 进度回调（每秒最多调一次）
            if (onProgress && Date.now() - lastProgressTime >= 1000) {
              lastProgressTime = Date.now();
              onProgress(Date.now());
            }
          } catch {
            // 非有效 JSON，跳过
          }
        }
        if (done) break;
      }
    }
  } catch (err) {
    logger.warn("opencode", "SSE 流读取异常，尝试拉取完整回复", { err: err.message });
  } finally {
    try { await reader.cancel(); } catch {}
  }

  // 4. AI 完成（或 SSE 异常），尝试拉取完整回复以确保不丢失内容
  //    SSE delta 可能不包含 step-finish 等完整数据，GET message 更可靠
  try {
    const msgRes = await fetch(base + "/session/" + esid + "/message?limit=1", {
      headers: h,
      signal: AbortSignal.timeout(10000),
    });
    if (msgRes.ok) {
      const messages = await msgRes.json();
      // messages 是数组，取最后一条
      const lastMsg = Array.isArray(messages) ? messages[messages.length - 1] : null;
      if (lastMsg?.parts) {
        const completeText = lastMsg.parts
          .filter(p => p.type === "text")
          .map(p => p.text)
          .join("");
        // 只在 GET 到的文本比 SSE 累加的更长时替换（更完整）
        if (completeText.length > fullText.length) {
          fullText = completeText;
        }
      }
    }
  } catch (err) {
    logger.debug("opencode", "GET message 失败，使用 SSE 累计文本", { err: err.message });
  }

  if (!fullText) {
    throw new Error("SSE 流结束但未收到回复");
  }

  logger.info("opencode", "streaming reply ok", { sid, len: fullText.length });
  return { text: fullText, parts: [], info: null };
}

/**
 * 同步请求（原 sendToAgent 的核心逻辑，作为流式失败的回退）
 */
async function syncRequest(base, h, sid, esid, body) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 600_000);

  try {
    const res = await fetch(base + "/session/" + esid + "/message", {
      method: "POST", headers: h,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(tm);

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const result = await res.json();
    const reply = (result.parts || []).filter(p => p.type === "text").map(p => p.text).join("");
    logger.info("opencode", "sync reply ok", { sid, len: reply.length });
    return { text: reply, parts: result.parts || [], info: result.info || null };
  } catch (err) {
    clearTimeout(tm);
    if (err.name === "AbortError") throw new Error("agent timeout (10min)");
    throw err;
  }
}
