/**
 * config.js — 配置管理
 * 优先级：环境变量 > config.json > 默认值
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// env var 前缀（用拼接避免换行截断问题）
const OC = "OP" + "ENCODE_";

const ENV = {
  WECHAT_TOKEN: "WECHAT_TOKEN",
  WECHAT_BASE_URL: "WECHAT_BASE_URL",
  WECHAT_CDN_BASE_URL: "WECHAT_CDN_BASE_URL",
  OC_API: OC + "API",
  OC_PASSWORD: OC + "PASSWORD",
  OC_AUTO_START: OC + "AUTO_START",
  OC_AGENT: OC + "AGENT",
  OC_MODEL: OC + "MODEL",
  LOG_DIR: "LOG_DIR",
  STATE_DIR: "STATE_DIR",
  ALLOW_FROM: "ALLOW_FROM",
  BOT_AGENT: "BOT_AGENT",
  LONG_POLL_TIMEOUT_MS: "LONG_POLL_TIMEOUT_MS",
};

function env(key, fallback) {
  return process.env[key] || fallback;
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
    opencodeAutoStart: env(ENV.OC_AUTO_START) !== undefined
      ? env(ENV.OC_AUTO_START) !== "false"
      : fc.opencodeAutoStart ?? true,
    opencodeAgent: env(ENV.OC_AGENT) || fc.opencodeAgent || null,
    opencodeModel: env(ENV.OC_MODEL) || fc.opencodeModel || null,

    // 路径
    logDir: env(ENV.LOG_DIR) || fc.logDir || resolve(__dirname, "logs"),
    stateDir: env(ENV.STATE_DIR) || fc.stateDir || resolve(__dirname, "state"),

    // 业务配置
    allowFrom: (env(ENV.ALLOW_FROM) || fc.allowFrom || "").split(",").map(s => s.trim()).filter(Boolean),
    botAgent: env(ENV.BOT_AGENT) || fc.botAgent || "WeChat-OpenCode-Bridge/1.0",
    longPollTimeoutMs: parseInt(env(ENV.LONG_POLL_TIMEOUT_MS)) || fc.longPollTimeoutMs || 35000,
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
  return getConfig();
}
