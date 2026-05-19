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
  // 已有 session 直接返回
  const key = sessionKey(userId, model);
  if (sessions.has(key)) return sessions.get(key);

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
  const tm = setTimeout(() => ctrl.abort(), 300_000);

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
          signal: AbortSignal.timeout(300_000),
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
    if (err.name === "AbortError") throw new Error("agent timeout (5min)");
    throw err;
  }
}

export async function checkHealth() {
  try { const d = await detect(); return !!d; } catch { return false; }
}

export async function startOpenCodeServer() {
  const d = await detect();
  if (d) { console.log("OK desktop OpenCode (" + d.port + ")"); return true; }
  return false;
}

export function stopOpenCodeServer() {}
