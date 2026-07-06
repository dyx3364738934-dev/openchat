/**
 * src/wechat-gateway.js — 微信网关（v2.1）
 *
 * 职责：
 *   1. 终端 ASCII QR 码显示（不打开看图器窗口）
 *   2. 5 分钟扫码超时 + 用户可输入 skip 跳过
 *   3. 微信长轮询 + 消息路由
 *   4. stdin 单次使用模式（避免与 REPL 冲突）
 *
 * 设计要点：
 *   - 自己实现 QR 流程（不依赖 wechatQrLogin，避免它打开看图器）
 *   - QR 用 qrcode 包的 toString({type: 'terminal'}) 打印 ASCII
 *   - stdin 监听用一次性的 readline，login 完成后立即 pause/destroy
 *   - REPL 启动后可以安全接管 stdin
 */

import { createInterface } from "node:readline";
import {
  getUpdates,
  sendMessage,
  notifyStart,
  notifyStop,
  extractTextFromItemList,
  MessageItemType,
} from "./wechat-api.js";
import qrcode from "qrcode";

const QR_TIMEOUT_MS = 5 * 60 * 1000;
const QR_POLL_INTERVAL_MS = 2000;
const BOT_TYPE = 3;

// ============================================================
// 终端 ASCII QR 显示
// ============================================================

/**
 * 在终端打印 ASCII QR 码（小字符模式）
 * @returns {Promise<boolean>} 是否成功打印
 */
async function printTerminalQR(url) {
  try {
    const ascii = await qrcode.toString(url, { type: "terminal", small: true });
    console.log("\n" + ascii);
    return true;
  } catch (err) {
    console.error(`QR 码打印失败: ${err.message}`);
    return false;
  }
}

// ============================================================
// 微信 QR 登录状态机（自定义实现）
// ============================================================

/**
 * 步骤 1: 获取登录二维码 URL
 * GET /ilink/bot/get_bot_qrcode?bot_type=3
 */
async function getBotQrcode(baseUrl) {
  const url = `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  const resp = await fetch(url, {
    headers: { "iLink-App-Id": "bot", "iLink-App-ClientVersion": "131585" },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`get_bot_qrcode HTTP ${resp.status}`);
  return await resp.json();
}

/**
 * 步骤 2: 轮询扫码状态
 * GET /ilink/bot/get_qrcode_status?qrcode=...&bot_type=3
 */
async function pollQrcodeStatus(baseUrl, qrcodeToken) {
  const url = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeToken)}&bot_type=${BOT_TYPE}`;
  const resp = await fetch(url, {
    headers: { "iLink-App-Id": "bot", "iLink-App-ClientVersion": "131585" },
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`get_qrcode_status HTTP ${resp.status}`);
  return await resp.json();
}

// ============================================================
// 微信登录（含 ASCII QR + 5 分钟超时 + skip 选项）
// ============================================================

/**
 * 微信登录主流程
 *
 * @returns {Promise<{status: 'ok'|'skipped'|'timeout'|'error', token?: string, userId?: string, accountId?: string}>}
 */
export async function wechatLoginWithSkip({ baseUrl = "https://ilinkai.weixin.qq.com" } = {}) {
  // 单次 stdin 监听（仅用于 skip 输入）
  let stdinRl = null;
  let skipResolve = null;

  const setupStdinListener = () => {
    return new Promise((resolve) => {
      skipResolve = resolve;
      stdinRl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false, // 不开 terminal 模式，避免 ANSI 噪音
      });
      stdinRl.on("line", (line) => {
        const t = line.trim().toLowerCase();
        if (t === "skip" || t === "s" || t === "q") {
          resolve({ status: "skipped" });
        }
      });
    });
  };

  const cleanupStdin = () => {
    if (stdinRl) {
      try { stdinRl.pause(); } catch {}
      try { stdinRl.close(); } catch {}
      stdinRl.removeAllListeners();
      stdinRl = null;
    }
  };

  try {
    // 步骤 1: 获取二维码 URL
    console.log("\n📱 正在获取二维码...");
    const qrData = await getBotQrcode(baseUrl);

    if (qrData.ret !== 0) {
      throw new Error(`获取二维码失败: ret=${qrData.ret} ${qrData.errmsg || ""}`);
    }

    const qrUrl = qrData.qrcode_img_content || qrData.qrcode_img_url || qrData.qrcode_url;
    const qrToken = qrData.qrcode || qrData.session_key;

    if (!qrUrl || !qrToken) {
      throw new Error("二维码响应缺少必要字段");
    }

    // 步骤 2: 在终端打印 ASCII QR
    console.log("\n╔════════════════════════════════════════════════╗");
    console.log("║        请用微信扫描下方二维码 (5 分钟时效)      ║");
    console.log("╚════════════════════════════════════════════════╝");
    await printTerminalQR(qrUrl);
    console.log("📱 也可以用微信扫一扫扫描以下链接:");
    console.log(`   ${qrUrl}\n`);
    console.log("💡 扫码完成后会自动继续；输入 skip / s / q 直接跳过 → REPL 模式\n");

    // 启动 stdin 监听（单次）
    const skipPromise = setupStdinListener();

    // 步骤 3: 轮询扫码状态
    const startTime = Date.now();
    let qrExpired = false;

    while (!qrExpired && Date.now() - startTime < QR_TIMEOUT_MS) {
      // 等待 2 秒或 skip 输入
      const winner = await Promise.race([
        sleep(QR_POLL_INTERVAL_MS).then(() => ({ type: "tick" })),
        skipPromise.then((v) => ({ type: "skip", value: v })),
      ]);

      if (winner.type === "skip") {
        cleanupStdin();
        return winner.value;
      }

      // 轮询扫码状态
      let status;
      try {
        status = await pollQrcodeStatus(baseUrl, qrToken);
      } catch (err) {
        // 网络抖动，继续轮询
        continue;
      }

      // 检查是否拿到 token
      const gotToken = status.bot_token || status.token || status.data?.bot_token;
      if (gotToken) {
        cleanupStdin();
        console.log(`\n✅ 扫码成功！Bot ID: ${status.account_id || status.ilink_bot_id || "?"}`);
        return {
          status: "ok",
          token: gotToken,
          accountId: status.account_id || status.ilink_bot_id || "wechat-bot",
          userId: status.user_id || status.ilink_user_id || "",
        };
      }

      // 状态机
      const statusName = (status.status || status.qrcode_status || "").toString().trim().toLowerCase();
      switch (statusName) {
        case "scaned":
        case "scanned":
          console.log("👀 已扫码，请在手机上确认登录...");
          break;
        case "need_verifycode":
          console.log("⚠️ 需要验证码，请在手机上完成验证");
          break;
        case "confirmed":
          // confirmed 但没有 token（异常情况）
          console.log("⏳ 等待确认...");
          break;
        case "expired":
          console.log("⏰ 二维码已过期");
          cleanupStdin();
          return { status: "timeout" };
      }
    }

    // 5 分钟超时
    cleanupStdin();
    console.log("\n⏰ 5 分钟超时未扫码");
    return { status: "timeout" };
  } catch (err) {
    cleanupStdin();
    return { status: "error", error: err.message };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// 微信长轮询 + 消息处理
// ============================================================

export class WeChatGateway {
  constructor({ token, baseUrl = "https://ilinkai.weixin.qq.com" }) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.getUpdatesBuf = "";
    this.running = false;
    this.listeners = new Set();
  }

  onMessage(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start() {
    if (this.running) return;
    this.running = true;

    try { await notifyStart({ baseUrl: this.baseUrl, token: this.token }); } catch {}

    while (this.running) {
      try {
        const resp = await getUpdates({
          baseUrl: this.baseUrl,
          token: this.token,
          getUpdatesBuf: this.getUpdatesBuf,
          timeoutMs: 35000,
        });

        if (resp.get_updates_buf) {
          this.getUpdatesBuf = resp.get_updates_buf;
        }

        // 错误处理
        if ((resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)) {
          if (resp.errcode === -14 || resp.ret === -14) {
            throw new Error("微信会话过期，需要重新登录");
          }
          await sleep(2000);
          continue;
        }

        // 处理消息
        for (const msg of resp.msgs ?? []) {
          const uid = msg.from_user_id;
          if (!uid) continue;

          const normalized = {
            from: uid,
            text: extractTextFromItemList(msg.item_list).trim(),
            hasImage: msg.item_list?.some((i) => i.type === MessageItemType.IMAGE),
            contextToken: msg.context_token,
            raw: msg,
          };

          for (const fn of this.listeners) {
            try { await fn(normalized); } catch (e) { console.error("listener error:", e.message); }
          }
        }
      } catch (err) {
        if (!this.running) break;
        console.error(`wechat poll error: ${err.message}`);
        await sleep(2000);
      }
    }
  }

  async stop() {
    this.running = false;
    try { await notifyStop({ baseUrl: this.baseUrl, token: this.token }); } catch {}
  }

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
