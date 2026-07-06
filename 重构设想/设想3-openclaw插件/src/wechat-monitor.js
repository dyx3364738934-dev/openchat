/**
 * src/wechat-monitor.js — 微信长轮询监控器
 *
 * 从原 openchat v1.5.0 的 bridge.js 改造而来，剥离了 opencode-client 部分
 * 只保留微信收发逻辑，作为 OpenClaw 插件的 messageStream 实现基础
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// 复用 openchat v1.5.0 模块
// ============================================================

const OPENCHAT_ROOT = resolvePath(__dirname, "..", "..", "..");
const openchatPath = (rel) => new URL(`file:///${join(OPENCHAT_ROOT, rel).replace(/\\/g, "/")}`).href;

const {
  getUpdates,
  sendMessage,
  notifyStart,
  notifyStop,
  extractTextFromItemList,
  MessageItemType,
} = await import(openchatPath("wechat-api.js"));

const { extractImageFromItems } = await import(openchatPath("cdn.js"));
const { setContextToken, restoreContextTokens, saveGetUpdatesBuf, loadGetUpdatesBuf } = await import(openchatPath("session-store.js"));

// ============================================================
// 微信监控器
// ============================================================

const DEFAULT_LONG_POLL_MS = 35000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2000;
const SESSION_EXPIRED_ERRCODE = -14;

export class WeChatMonitor {
  constructor({ token, baseUrl = "https://ilinkai.weixin.qq.com", accountId = "default" }) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.accountId = accountId;
    this.getUpdatesBuf = "";
    this.consecutiveFailures = 0;
    this.running = false;
    this.listeners = new Set();
  }

  /** 注册消息回调 */
  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 启动 */
  async start() {
    if (this.running) return;
    this.running = true;

    // 恢复 context tokens
    restoreContextTokens(this.accountId);
    this.getUpdatesBuf = loadGetUpdatesBuf(this.accountId) ?? "";

    // 通知微信
    try { await notifyStart({ baseUrl: this.baseUrl, token: this.token }); } catch {}

    // 主循环
    while (this.running) {
      try {
        const resp = await getUpdates({
          baseUrl: this.baseUrl,
          token: this.token,
          getUpdatesBuf: this.getUpdatesBuf,
          timeoutMs: DEFAULT_LONG_POLL_MS,
        });

        // 错误处理
        const isApiError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
        if (isApiError) {
          if (resp.errcode === SESSION_EXPIRED_ERRCODE) {
            throw new Error("微信会话过期，需要重新扫码");
          }
          this.consecutiveFailures++;
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        this.consecutiveFailures = 0;

        // 保存同步游标
        if (resp.get_updates_buf) {
          this.getUpdatesBuf = resp.get_updates_buf;
          saveGetUpdatesBuf(this.accountId, this.getUpdatesBuf);
        }

        // 处理消息
        for (const msg of resp.msgs ?? []) {
          for (const listener of this.listeners) {
            try {
              await listener(msg);
            } catch (err) {
              console.error("listener error:", err.message);
            }
          }
        }
      } catch (err) {
        if (!this.running) break;
        this.consecutiveFailures++;
        console.error(`wechat poll error (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, err.message);
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await sleep(30000);
          this.consecutiveFailures = 0;
        } else {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
  }

  /** 停止 */
  async stop() {
    this.running = false;
    try { await notifyStop({ baseUrl: this.baseUrl, token: this.token }); } catch {}
  }

  /** 发消息 */
  async send({ toUserId, text, contextToken }) {
    return await sendMessage({
      baseUrl: this.baseUrl,
      token: this.token,
      toUserId,
      text,
      contextToken,
    });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
