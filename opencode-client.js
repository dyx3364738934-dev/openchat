/**
 * opencode-client.js — OpenCode HTTP API 客户端
 * 仅从环境变量获取桌面版密码（OpenCode 内置终端自动注入）
 * 无其他密码来源，保持极简
 */
import { execSync } from "node:child_process";
import { logger } from "./logger.js";
import { getConfig } from "./config.js";

const OC = "OP" + "ENCODE_";

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

const sessions = new Map();
const locks = new Map();

async function getOrCreateSession(userId) {
  if (sessions.has(userId)) return sessions.get(userId);
  if (locks.has(userId)) return locks.get(userId);

  let resolveLock;
  locks.set(userId, new Promise(r => { resolveLock = r; }));

  try {
    const base = await baseUrl();
    const h = headers();
    const cfg = getConfig();
    const mid = cfg.opencodeModel || "deepseek-v4-pro";
    const pid = mid.includes("/") ? mid.split("/")[0] : "deepseek";

    const r = await fetch(base + "/session", {
      method: "POST", headers: h,
      body: JSON.stringify({ agent: cfg.opencodeAgent || "build", model: { id: mid, providerID: pid } }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("session create HTTP " + r.status);

    const s = await r.json();
    sessions.set(userId, s.id);
    logger.info("opencode", "session created", { userId, sid: s.id });
    return s.id;
  } finally {
    resolveLock?.();
    locks.delete(userId);
  }
}

// ============================================================
// 核心
// ============================================================

export async function resetSession(userId) {
  sessions.delete(userId);
}

export async function sendToAgent(userId, text, opts = {}) {
  const base = await baseUrl();
  const h = headers();
  const sid = await getOrCreateSession(userId);

  // 切换 model/agent 时重建 session
  if (opts.model || opts.agent) {
    const cfg = getConfig();
    const mid = opts.model || cfg.opencodeModel || "deepseek-v4-pro";
    const pid = mid.includes("/") ? mid.split("/")[0] : "deepseek";
    const r = await fetch(base + "/session", {
      method: "POST", headers: h,
      body: JSON.stringify({ agent: opts.agent || cfg.opencodeAgent || "build", model: { id: mid, providerID: pid } }),
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) { const s = await r.json(); sessions.set(userId, s.id); }
  }

  const esid = encodeURIComponent(sid);
  logger.info("opencode", "send", { userId, sid, textLen: text.length });

  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 300_000);

  try {
    const res = await fetch(base + "/session/" + esid + "/message", {
      method: "POST", headers: h,
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
      signal: ctrl.signal,
    });
    clearTimeout(tm);

    if (!res.ok) {
      if (res.status === 404) {
        sessions.delete(userId);
        const newSid = await getOrCreateSession(userId);
        const r2 = await fetch(base + "/session/" + encodeURIComponent(newSid) + "/message", {
          method: "POST", headers: h,
          body: JSON.stringify({ parts: [{ type: "text", text }] }),
          signal: AbortSignal.timeout(300_000),
        });
        if (!r2.ok) throw new Error("retry HTTP " + r2.status);
        const r2j = await r2.json();
        const t2 = (r2j.parts || []).filter(p => p.type === "text").map(p => p.text).join("");
        return { text: t2, parts: r2j.parts || [], info: r2j.info || null };
      }
      throw new Error("HTTP " + res.status);
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
