/**
 * logger.js — 文件日志管理 + 可选独立 PowerShell 窗口实时 tail
 *
 * 使用方式：
 *   import { logger } from "./logger.js"
 *   logger.info("bridge", "收到消息", { from: "xxx" })
 *   logger.error("wechat", "API 调用失败", err)
 *
 * 日志格式：
 *   2026-05-17 14:30:25.123 [INFO] [bridge] 收到消息 from=xxx
 *
 * 独立日志窗口：
 *   调用 logger.openLogWindow() 会弹出一个新的 PowerShell 窗口
 *   实时滚动显示最新 50 行日志 + 后续追加的内容
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { getConfig } from "./config.js";

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

let _logPath = null;
let _logLevel = LOG_LEVELS.INFO;
let _windowOpened = false;

function getLogPath() {
  if (_logPath) return _logPath;
  const { logDir } = getConfig();
  mkdirSync(logDir, { recursive: true });
  _logPath = resolve(logDir, "bridge.log");
  return _logPath;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function formatMessage(level, module, message, extra) {
  let line = `${timestamp()} [${level}] [${module}] ${message}`;
  if (extra !== undefined) {
    if (typeof extra === "string") {
      line += ` | ${extra}`;
    } else if (extra instanceof Error) {
      line += ` | ${extra.message}`;
      if (extra.stack) {
        const stackLines = extra.stack.split("\n").slice(1, 4);
        for (const sl of stackLines) {
          line += `\n${timestamp()} [${level}] [${module}]   ${sl.trim()}`;
        }
      }
    } else {
      line += ` | ${JSON.stringify(extra)}`;
    }
  }
  return line;
}

function writeLog(level, module, message, extra) {
  const line = formatMessage(level, module, message, extra);
  const logPath = getLogPath();

  // 同时输出到控制台（主进程能看到）
  const consoleMethod = level === "ERROR" ? console.error :
    level === "WARN" ? console.warn : console.log;
  consoleMethod(`[${module}] ${message}`);

  // 写入日志文件
  try {
    appendFileSync(logPath, line + "\n", "utf-8");
  } catch (err) {
    console.error(`logger: 写入日志文件失败 ${err.message}`);
  }
}

export const logger = {
  setLevel(level) {
    if (LOG_LEVELS[level] !== undefined) {
      _logLevel = LOG_LEVELS[level];
    }
  },

  debug(module, message, extra) {
    if (_logLevel <= LOG_LEVELS.DEBUG) {
      writeLog("DEBUG", module, message, extra);
    }
  },

  info(module, message, extra) {
    if (_logLevel <= LOG_LEVELS.INFO) {
      writeLog("INFO", module, message, extra);
    }
  },

  warn(module, message, extra) {
    if (_logLevel <= LOG_LEVELS.WARN) {
      writeLog("WARN", module, message, extra);
    }
  },

  error(module, message, extra) {
    if (_logLevel <= LOG_LEVELS.ERROR) {
      writeLog("ERROR", module, message, extra);
    }
  },

  /** 获取日志文件路径 */
  getLogFilePath() {
    return getLogPath();
  },

  /**
   * 弹出一个独立的 PowerShell 窗口，实时显示日志
   * 只在 Windows 上有效，每个进程只打开一次
   */
  openLogWindow() {
    if (_windowOpened) return;
    _windowOpened = true;

    const logPath = getLogPath();

    // 确保日志文件存在
    if (!existsSync(logPath)) {
      appendFileSync(logPath, "", "utf-8");
    }

    try {
      const ps = spawn("powershell", [
        "-NoExit",
        "-Command",
        `Write-Host "=== WeChat-OpenCode Bridge 实时日志 ===" -ForegroundColor Cyan; ` +
        `Write-Host "日志文件: ${logPath}" -ForegroundColor DarkGray; ` +
        `Write-Host ""; ` +
        `Get-Content -Wait -Tail 50 -Encoding UTF8 "${logPath}"`
      ], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      ps.unref();
      console.log("📺 已打开独立日志窗口");
      logger.info("logger", "独立日志窗口已打开");
    } catch (err) {
      console.warn(`⚠️  无法打开独立日志窗口: ${err.message}`);
      logger.warn("logger", "无法打开独立日志窗口", err);
    }
  },
};

export { LOG_LEVELS };
