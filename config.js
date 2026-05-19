/**
 * config.js — 配置管理
 * 优先级：环境变量 > config.json > 默认值
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// env var 前缀（用拼接避免换行截断问题）
export const OC_PREFIX = "OP" + "ENCODE_";

const ENV = {
  WECHAT_TOKEN: "WECHAT_TOKEN",
  WECHAT_BASE_URL: "WECHAT_BASE_URL",
  WECHAT_CDN_BASE_URL: "WECHAT_CDN_BASE_URL",
  OC_API: OC_PREFIX + "API",
  OC_PASSWORD: OC_PREFIX + "PASSWORD",
  OC_AUTO_START: OC_PREFIX + "AUTO_START",
  OC_AGENT: OC_PREFIX + "AGENT",
  OC_MODEL: OC_PREFIX + "MODEL",
  OC_SYSTEM_PROMPT: OC_PREFIX + "SYSTEM_PROMPT",
  LOG_DIR: "LOG_DIR",
  STATE_DIR: "STATE_DIR",
  ALLOW_FROM: "ALLOW_FROM",
  BOT_AGENT: "BOT_AGENT",
  LONG_POLL_TIMEOUT_MS: "LONG_POLL_TIMEOUT_MS",
};

function env(key, fallback) {
  return process.env[key] || fallback;
}

/** 将 allowFrom 配置规范化为字符串数组（支持 string 和 array 类型） */
function normalizeAllowFrom(raw) {
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map(s => s.trim()).filter(Boolean);
  return [];
}

function loadConfig() {
  const configPath = resolve(__dirname, "config.json");
  let fc = {};
  if (existsSync(configPath)) {
    try { fc = JSON.parse(readFileSync(configPath, "utf-8")); } catch (err) {
      console.warn(`config.json 解析失败: ${err.message}`);
    }
  }

  return {
    // 微信配置
    wechatToken: env(ENV.WECHAT_TOKEN) || fc.wechatToken || null,
    wechatBaseUrl: env(ENV.WECHAT_BASE_URL) || fc.wechatBaseUrl || "https://ilinkai.weixin.qq.com",
    wechatCdnBaseUrl: env(ENV.WECHAT_CDN_BASE_URL) || fc.wechatCdnBaseUrl || "https://novac2c.cdn.weixin.qq.com/c2c",

    // OpenCode 配置
    opencodeApi: env(ENV.OC_API) || fc.opencodeApi || "http://127.0.0.1:4096",
    opencodePassword: env(ENV.OC_PASSWORD) || fc.opencodePassword || null,
    opencodeAutoStart: (() => {
      const ev = env(ENV.OC_AUTO_START);
      if (ev !== undefined && ev !== "") return ev.toLowerCase() !== "false" && ev !== "0";
      return fc.opencodeAutoStart ?? true;
    })(),
    opencodeAgent: env(ENV.OC_AGENT) || fc.opencodeAgent || null,
    opencodeModel: env(ENV.OC_MODEL) || fc.opencodeModel || null,
    // 图片消息由当前模型处理（不再自动切换视觉模型）
    // 如需使用视觉模型，请通过 /model 命令手动切换
    
    // 系统提示词：注入到每条消息中，定义 AI 的人格和行为准则
    // 支持三种写法:
    //   1. 环境变量: OPENCODE_SYSTEM_PROMPT="你是微信助手..."
    //   2. config.json: { "opencodeSystemPrompt": "你是微信助手..." }
    //   3. 文件引用: { "opencodeSystemPromptFile": "prompt.txt" } 或 OPENCODE_SYSTEM_PROMPT_FILE=prompt.txt
    //      文件路径相对于 config.json 所在目录，支持多行和 Markdown
    // 不设置则不注入额外提示词
    opencodeSystemPrompt: env(ENV.OC_SYSTEM_PROMPT) || fc.opencodeSystemPrompt || null,
    opencodeSystemPromptFile: fc.opencodeSystemPromptFile || null,

    // 路径
    logDir: env(ENV.LOG_DIR) || fc.logDir || resolve(__dirname, "logs"),
    stateDir: env(ENV.STATE_DIR) || fc.stateDir || resolve(__dirname, "state"),

    // 业务配置
    allowFrom: normalizeAllowFrom(env(ENV.ALLOW_FROM) || fc.allowFrom || []),
    botAgent: env(ENV.BOT_AGENT) || fc.botAgent || "WeChat-OpenCode-Bridge/1.0",
    longPollTimeoutMs: parseInt(env(ENV.LONG_POLL_TIMEOUT_MS)) || fc.longPollTimeoutMs || 35000,
    // 启动时是否发送欢迎消息（默认 true，设为 false 关闭）
    welcomeEnabled: (() => {
      const ev = env("WELCOME_ENABLED");
      if (ev !== undefined && ev !== "") return ev.toLowerCase() !== "false" && ev !== "0";
      return fc.welcomeEnabled ?? true;
    })(),
    // 付费模型白名单（不在白名单中的付费模型不显示）
    paidAllowlist: new Set(fc.paidAllowlist || [
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
    ]),
    // 供应商显示名称映射
    providerLabels: fc.providerLabels || {
      opencode: "opencode (Zen)",
      deepseek: "deepseek",
      google: "google",
      "opencode-go": "opencode (Go)",
      openrouter: "openrouter",
    },
  };
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function saveToken(token) {
  const configPath = resolve(__dirname, "config.json");
  let cfg = {};
  if (existsSync(configPath)) {
    try { cfg = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
  }
  cfg.wechatToken = token;
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
}

let _config = null;
let _systemPrompt = null;

export function getConfig() {
  if (!_config) {
    _config = loadConfig();
    ensureDir(_config.logDir);
    ensureDir(_config.stateDir);
  }
  return _config;
}

export function reloadConfig() {
  _config = null;
  _systemPrompt = null;
  return getConfig();
}

/**
 * 获取系统提示词（优先级: 环境变量 > config.json 直接值 > 文件引用）
 * 文件内容会被缓存，直到 reloadConfig() 被调用
 * @returns {string|null} 系统提示词内容，未配置则返回 null
 */
export function getSystemPrompt() {
  if (_systemPrompt !== null) return _systemPrompt || null;

  const cfg = getConfig();

  // 优先级 1: 环境变量
  const envPrompt = process.env[ENV.OC_SYSTEM_PROMPT];
  if (envPrompt) {
    _systemPrompt = envPrompt;
    return _systemPrompt;
  }

  // 优先级 2: config.json 直接值
  if (cfg.opencodeSystemPrompt) {
    _systemPrompt = cfg.opencodeSystemPrompt;
    return _systemPrompt;
  }

  // 优先级 3: 文件引用
  if (cfg.opencodeSystemPromptFile) {
    const filePath = resolve(__dirname, cfg.opencodeSystemPromptFile);
    if (existsSync(filePath)) {
      try {
        _systemPrompt = readFileSync(filePath, "utf-8").trim();
        console.log(`📋 系统提示词已从 ${cfg.opencodeSystemPromptFile} 加载 (${_systemPrompt.length} 字符)`);
        return _systemPrompt;
      } catch (err) {
        console.warn(`系统提示词文件加载失败: ${err.message}`);
        return null;
      }
    } else {
      console.warn(`系统提示词文件不存在: ${filePath}`);
      return null;
    }
  }

  _systemPrompt = ""; // 标记为已检查，避免重复文件 IO
  return null;
}
