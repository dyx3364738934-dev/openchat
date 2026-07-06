/**
 * lib/openchat-sdk.js — openchat 独立化 SDK (mimocode 适配版)
 *
 * 适配对象：mimocode 0.1.0（基于 OpenCode fork）
 * - 验证时间：2026-06-12
 * - 验证结论：mimo serve 无 Basic Auth bug，7 个免费模型可直接抓
 *
 * 与 opencode 1.15.x 关键差异：
 * - 鉴权：mimo 无，opencode 1.15 有（且 SDK client 不带 header → 401）
 * - 列模型端点：mimo 用 /provider (JSON)，opencode 1.15 用 /api/model
 * - 命令名：mimo vs opencode
 * - 配置目录：~/.config/mimocode vs ~/.config/opencode
 *
 * 设计原则：
 * 1. 同时支持 mimo 和 opencode（运行时检测）
 * 2. 接口形态与原 openchat 的 opencode-client.js 对齐
 * 3. 不依赖桌面版，server 子进程由 bootstrap 管理
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// ============================================================
// Runtime 检测：自动选择 mimo 或 opencode
// ============================================================

let _detectedCli = null; // { name, path, version }

/**
 * 检测本机可用的 agent CLI
 * 优先级：mimo > opencode
 */
export function detectAgentCli() {
  if (_detectedCli) return _detectedCli;

  const candidates = [
    // mimocode 优先（验证过可用）
    {
      name: "mimo",
      paths: [
        "D:\\nodejs\\node-v20.11.0-win-x64\\mimo.cmd",
        "mimo.cmd",
        "mimo",
      ],
    },
    // opencode fallback
    {
      name: "opencode",
      paths: [
        "D:\\nodejs\\node-v20.11.0-win-x64\\opencode.cmd",
        "opencode.cmd",
        "opencode",
      ],
    },
  ];

  for (const c of candidates) {
    for (const p of c.paths) {
      try {
        // Windows: .cmd 文件需要 shell:true
        const isWin = process.platform === "win32";
        const needsShell = isWin && (p.endsWith(".cmd") || p.endsWith(".bat"));
        const r = spawnSync(p, ["--version"], {
          stdio: "pipe",
          windowsHide: true,
          shell: needsShell,
        });
        if (r.status === 0 && r.stdout) {
          // 去掉 ANSI 颜色码
          const raw = r.stdout.toString().replace(/\x1b\[[0-9;]*m/g, "").trim();
          const version = raw.split(/\s+/).pop() || raw; // 取最后一个 token
          _detectedCli = { name: c.name, path: p, version };
          return _detectedCli;
        }
      } catch {}
    }
  }
  return null;
}

// ============================================================
// 配置层
// ============================================================

/**
 * 解析 agent server 配置
 */
export function resolveServeConfig(opts = {}) {
  const cli = detectAgentCli();
  const prefix = cli?.name === "mimo" ? "MIMOCODE_" : "OPENCODE_";
  return {
    host: opts.host || process.env[`${prefix}SERVER_HOSTNAME`] || "127.0.0.1",
    port: parseInt(opts.port || process.env[`${prefix}SERVER_PORT`] || (cli?.name === "mimo" ? "14113" : "4096")),
    username: opts.username || process.env[`${prefix}SERVER_USERNAME`] || "opencode",
    password: opts.password || process.env[`${prefix}SERVER_PASSWORD`] || null,
    cli: cli?.name || "mimo",
    timeoutMs: parseInt(opts.timeoutMs || "10000"),
  };
}

// ============================================================
// 鉴权层
// ============================================================

export function authHeader(cfg) {
  // mimo 不需要鉴权
  if (cfg.cli === "mimo" || !cfg.password) return {};
  const creds = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
  return { Authorization: `Basic ${creds}` };
}

// ============================================================
// 连接检测层
// ============================================================

export async function checkHealth(cfg) {
  const url = `http://${cfg.host}:${cfg.port}/global/health`;
  try {
    const r = await fetch(url, {
      headers: authHeader(cfg),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!r.ok) return { healthy: false, error: `HTTP ${r.status}` };
    const body = await r.json();
    return { healthy: !!body.healthy, version: body.version };
  } catch (err) {
    return { healthy: false, error: err.message };
  }
}

// ============================================================
// Session 层
// ============================================================

export async function createSession(cfg, opts = {}) {
  const url = `http://${cfg.host}:${cfg.port}/session`;
  const body = { agent: opts.agent || "build" };
  if (opts.model) {
    const [providerID, ...rest] = opts.model.split("/");
    body.model = {
      id: rest.join("/"),
      providerID,
    };
  }
  const r = await fetch(url, {
    method: "POST",
    headers: { ...authHeader(cfg), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`session create HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  return await r.json();
}

// ============================================================
// 消息层
// ============================================================

export async function sendMessage(cfg, sessionId, parts, opts = {}) {
  const url = `http://${cfg.host}:${cfg.port}/session/${encodeURIComponent(sessionId)}/message`;
  const body = { parts: typeof parts === "string" ? [{ type: "text", text: parts }] : parts };
  if (opts.system) body.system = opts.system;

  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 600_000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { ...authHeader(cfg), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(tm);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 300)}`);
    }
    const result = await r.json();
    return extractReply(result);
  } catch (err) {
    clearTimeout(tm);
    if (err.name === "AbortError") throw new Error("agent timeout (10min)");
    throw err;
  }
}

function extractReply(result) {
  const parts = Array.isArray(result.parts) ? result.parts : [];
  const textParts = parts.filter((p) => p.type === "text").map((p) => p.text).join("");
  if (textParts.trim()) return { text: textParts, parts, info: result.info || null };
  const reasoning = parts.filter((p) => p.type === "reasoning" || p.type === "thinking").map((p) => p.text).join("");
  return { text: reasoning, parts, info: result.info || null };
}

// ============================================================
// 模型层：适配 mimo + opencode 两套 endpoint
// ============================================================

/**
 * 列出可用模型
 * 自动适配 mimo (/provider) 和 opencode (/api/model)
 */
export async function listModels(cfg) {
  // mimo 用 /provider (JSON)，opencode 1.15.x 用 /api/model
  const endpoints = cfg.cli === "mimo"
    ? [`http://${cfg.host}:${cfg.port}/provider`]
    : [`http://${cfg.host}:${cfg.port}/api/model`];

  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        headers: authHeader(cfg),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (!r.ok) continue;
      const data = await r.json();
      // mimo: { all: [{ id, models: {...} }], default: {...}, connected: [...] }
      // opencode: [ { id, name, providerID, cost, capabilities } ]
      if (cfg.cli === "mimo") {
        return parseMimoProviders(data);
      } else {
        return parseOpencodeModels(data);
      }
    } catch {
      continue;
    }
  }
  return [];
}

/**
 * 解析 mimo /provider 返回结构
 */
function parseMimoProviders(data) {
  if (!data?.all || !Array.isArray(data.all)) return [];
  const result = [];
  for (const provider of data.all) {
    const models = provider.models || {};
    for (const [modelId, model] of Object.entries(models)) {
      const free = model?.cost?.input === 0 && model?.cost?.output === 0;
      result.push({
        id: `${provider.id}/${modelId}`,
        name: model?.name || modelId,
        provider: provider.id,
        free,
        hasImage: model?.capabilities?.input?.image || false,
        status: model?.status || "active",
        context: model?.limit?.context || 0,
      });
    }
  }
  return result.sort((a, b) => {
    if (a.free && !b.free) return -1;
    if (!a.free && b.free) return 1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * 解析 opencode /api/model 返回结构
 */
function parseOpencodeModels(data) {
  if (!Array.isArray(data)) return [];
  return data.map((m) => ({
    id: `${m.providerID}/${m.id}`,
    name: m.name || m.id,
    provider: m.providerID,
    free:
      m.id.toLowerCase().endsWith("-free") ||
      (Array.isArray(m.cost) && m.cost.some((c) => c.input === 0 && c.output === 0)),
    hasImage: Array.isArray(m.capabilities?.input) && m.capabilities.input.includes("image"),
    status: "active",
    context: 0,
  }));
}

// ============================================================
// 服务端引导：启动 mimo/opencode serve 子进程
// ============================================================

/**
 * 启动 agent CLI 的 headless server
 * @returns {Promise<{cfg, process, stop, cli}>}
 */
export async function bootstrapServer(opts = {}) {
  const cli = detectAgentCli();
  if (!cli) {
    throw new Error(
      "找不到 mimo 或 opencode CLI。请安装：\n" +
      "  mimo: npm install -g @mimo-ai/cli\n" +
      "  opencode: npm install -g opencode-ai"
    );
  }

  const port = parseInt(opts.port || process.env[`${cli.name === "mimo" ? "MIMOCODE" : "OPENCODE"}_SERVER_PORT`] || (cli.name === "mimo" ? "14113" : "4096"));
  const host = opts.host || "127.0.0.1";

  const cfg = resolveServeConfig({ ...opts, host, port });

  // 检测是否已有 serve 在跑
  const existing = await checkHealth(cfg);
  if (existing.healthy) {
    return {
      cfg,
      process: null,
      stop: () => {},
      alreadyRunning: true,
      cli: cli.name,
    };
  }

  // 启动子进程（**不在 env 里设 OPENCODE_SERVER_PASSWORD**，因为 mimo 不需要，opencode 1.15 反而会触发 bug）
  const args = ["serve", "--port", String(port), "--hostname", host];
  const child = spawn(cli.path, args, {
    stdio: opts.silent ? "ignore" : ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  if (opts.onLog && child.stdout) child.stdout.on("data", (d) => opts.onLog("out", d.toString()));
  if (opts.onLog && child.stderr) child.stderr.on("data", (d) => opts.onLog("err", d.toString()));

  // 等待启动（最多 30s）
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    const h = await checkHealth(cfg);
    if (h.healthy) break;
    lastError = h.error;
    await sleep(500);
  }
  const final = await checkHealth(cfg);
  if (!final.healthy) {
    child.kill();
    throw new Error(
      `${cli.name} serve 启动失败：${final.error || "未就绪"}\n` +
      `  最后错误：${lastError}`
    );
  }

  return {
    cfg,
    process: child,
    stop: () => {
      // 用 taskkill 而不是 kill()，避免误杀
      try {
        spawn("taskkill", ["/PID", String(child.pid), "/F", "/T"], { windowsHide: true });
      } catch {
        try { child.kill(); } catch {}
      }
    },
    alreadyRunning: false,
    cli: cli.name,
  };
}

// ============================================================
// 一站式调用
// ============================================================

const _sessionCache = new Map();

export async function callAgent(userId, text, opts = {}) {
  const cfg = resolveServeConfig(opts);
  const agent = opts.agent || "build";
  const model = opts.model;

  let sid;
  const cacheKey = `${userId}:${model || "default"}`;
  if (_sessionCache.has(cacheKey)) {
    sid = _sessionCache.get(cacheKey);
    _sessionCache.delete(cacheKey);
    _sessionCache.set(cacheKey, sid); // LRU
  } else {
    const session = await createSession(cfg, { agent, model });
    sid = session.id;
    _sessionCache.set(cacheKey, sid);
    if (_sessionCache.size > 100) {
      const oldest = _sessionCache.keys().next().value;
      _sessionCache.delete(oldest);
    }
  }

  return await sendMessage(cfg, sid, text, opts);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
