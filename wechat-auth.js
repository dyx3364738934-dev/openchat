/**
 * wechat-auth.js — 微信机器人 QR 扫码登录
 *
 * 登录流程：
 *   1. POST /ilink/bot/get_bot_qrcode?bot_type=3 → 获取二维码 URL
 *   2. 在终端显示二维码（用 qrcode 包）
 *   3. GET  /ilink/bot/get_qrcode_status?qrcode=... → 长轮询等待扫码
 *
 * 状态机：
 *   wait → scanned → need_verifycode → confirmed
 *   wait → expired → 重新获取二维码（最多 3 次）
 *   wait → scaned_but_redirect → 切换 IDC
 */

import qrcode from "qrcode";
import { logger } from "./logger.js";

// ======== 工具函数 ========

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ======== 常量 ========

const BOT_TYPE = 3; // ilink bot 类型
const QR_REFRESH_MAX = 3; // 二维码过期后最多刷新次数
const LOGIN_TIMEOUT_MS = 480_000; // 登录总超时 8 分钟
const QR_POLL_DELAY_MS = 2000; // 每次轮询间隔 2 秒（防止 expired 洪水）
const QR_REFRESH_DELAY_MS = 3000; // QR 过期后刷新前的冷却

// ======== QR 码登录 ========

/**
 * 在终端和外部窗口显示二维码
 * - 终端：ASCII 渲染（备选）
 * - 外部：生成 PNG 图片 + 自动打开系统看图器（推荐）
 * - 回退：打印 URL 文本
 */
async function displayQRCode(url) {
  // 1) 生成 PNG 图片
  try {
    const { writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { execSync } = await import("node:child_process");

    const pngPath = resolve(process.env.TEMP || "/tmp", "wechat-bridge-qr.png");
    const pngBuffer = await qrcode.toBuffer(url, { width: 400, margin: 2 });
    writeFileSync(pngPath, pngBuffer);

    // 2) 用系统默认程序打开图片
    console.log("📱 二维码图片已生成，正在打开...");
    try {
      if (process.platform === "win32") {
        execSync(`start "" "${pngPath}"`, { windowsHide: true, timeout: 3000 });
      } else if (process.platform === "darwin") {
        execSync(`open "${pngPath}"`, { timeout: 3000 });
      } else {
        execSync(`xdg-open "${pngPath}"`, { timeout: 3000 });
      }
      console.log(`   图片路径: ${pngPath}`);
      console.log("   如果未自动打开，请手动打开上述文件\n");
    } catch {
      console.log(`   请手动打开: ${pngPath}\n`);
    }
  } catch (err) {
    // 图片生成失败 → 回退终端渲染
    try {
      const qrString = await qrcode.toString(url, { type: "terminal", small: true });
      console.log(qrString);
    } catch {
      console.log(`\n📱 请用手机微信扫描以下链接：\n${url}\n`);
    }
  }
}

/**
 * 构建 GET 请求的通用头
 */
function buildGetHeaders() {
  return {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(
      ((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (1 & 0xff)
    ),
  };
}

/**
 * 发起 GET 请求
 */
async function apiGet(url, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: buildGetHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    const raw = await res.text();
    // 尝试 JSON 解析，失败则返回原始文本
    try {
      return JSON.parse(raw);
    } catch {
      // 可能返回纯文本 token，包装成对象
      if (raw.trim().length === 32 && /^[a-f0-9]+$/i.test(raw.trim())) {
        return { bot_token: raw.trim() };
      }
      return { _raw: raw };
    }
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * 步骤 1：获取登录二维码
 * GET /ilink/bot/get_bot_qrcode?bot_type=3
 *
 * 返回字段说明：
 *   qrcode              — UUID token，用于轮询状态
 *   qrcode_img_content  — 微信可识别的绑定链接（URL），应生成二维码让用户扫描
 *   qrcode_img_url      — 二维码图片 URL（可选）
 */
async function getBotQrcode(baseUrl) {
  const url = `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  logger.info("wechat-auth", "获取登录二维码", { url });

  const resp = await apiGet(url, 15000);

  logger.debug("wechat-auth", "getBotQrcode 响应 keys", Object.keys(resp));

  if (resp.ret !== 0) {
    throw new Error(`获取二维码失败: ret=${resp.ret} errmsg=${resp.errmsg ?? ""}`);
  }

  // qrcode_img_content 是微信可识别的绑定链接（最关键的字段）
  // 优先使用 qrcode_img_content，其次回退到 qrcode_img_url
  const qrDisplayUrl = resp.qrcode_img_content || resp.qrcode_img_url || resp.qrcode_url;

  if (!qrDisplayUrl) {
    throw new Error("获取二维码失败: API 未返回二维码链接 (qrcode_img_content / qrcode_img_url)");
  }

  return {
    qrcodeUrl: qrDisplayUrl,
    sessionKey: resp.qrcode || resp.session_key,
    message: resp.errmsg || "请扫描二维码",
  };
}

/**
 * 步骤 2：轮询等待扫码结果
 * GET /ilink/bot/get_qrcode_status?qrcode={sessionKey}&bot_type=3
 *
 * 返回状态（字符串）：
 *    "wait"     — 等待扫码
 *    "scaned"   — 已扫码，等待确认
 *    "confirmed" — 已确认，登录成功
 *    "expired"  — 二维码过期
 *    "need_verifycode" — 需要验证码
 *    "scaned_but_redirect" — 已扫码但需切换 IDC
 */
async function pollQrcodeStatus(baseUrl, sessionKey, timeoutMs = 60000) {
  const url = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(sessionKey)}&bot_type=${BOT_TYPE}`;
  logger.debug("wechat-auth", "轮询二维码状态", { sessionKey: sessionKey.slice(0, 20) });

  try {
    const resp = await apiGet(url, timeoutMs);
    // 打印完整响应，方便调试
    logger.debug("wechat-auth", "QR 状态响应", JSON.stringify(resp).slice(0, 500));
    return resp;
  } catch (err) {
    if (err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

/**
 * 完整登录流程（状态机）
 *
 * @param {object} opts
 * @param {string} opts.baseUrl — 微信 API 地址
 * @returns {Promise<{botToken: string, accountId: string, baseUrl: string, userId: string}>}
 */
export async function wechatQrLogin(opts = {}) {
  const baseUrl = opts.baseUrl || "https://ilinkai.weixin.qq.com";

  console.log("\n🔑 === 微信机器人登录 ===\n");
  logger.info("wechat-auth", "开始 QR 扫码登录");

  let refreshCount = 0;
  const startTime = Date.now();

  while (true) {
    // 检查总超时
    if (Date.now() - startTime > LOGIN_TIMEOUT_MS) {
      throw new Error("登录超时（超过 8 分钟未扫码）");
    }

    // 步骤 1：获取二维码
    const { qrcodeUrl, sessionKey } = await getBotQrcode(baseUrl);
    console.log("📱 请用手机微信扫描下方二维码：\n");
    await displayQRCode(qrcodeUrl);
    console.log("\n⏳ 等待扫码...（二维码有效期约 2 分钟）\n");

    // 步骤 2：轮询状态
    let loggedIn = false;
    let loginResult = null;

    while (!loggedIn) {
      if (Date.now() - startTime > LOGIN_TIMEOUT_MS) {
        throw new Error("登录超时（超过 8 分钟）");
      }

      const resp = await pollQrcodeStatus(baseUrl, sessionKey);

      // 尝试多种可能的 token 字段名（debug 级别记录完整响应，生产环境不打印）
      logger.debug("wechat-auth", "QR 响应字段", Object.keys(resp));

      // 尝试多种可能的 token 字段名
      const gotToken = resp.bot_token || resp.token || resp.data?.bot_token || resp.data?.token || resp.result?.bot_token;

      if (gotToken) {
        console.log("✅ 登录成功！获取到 token");
        logger.info("wechat-auth", "登录成功", { tokenPreview: gotToken.slice(0, 16) + "..." });

        loginResult = {
          botToken: gotToken,
          accountId: resp.account_id || resp.ilink_bot_id || resp.data?.ilink_bot_id || "wechat-bot",
          baseUrl: resp.base_url || resp.baseurl || baseUrl,
          userId: resp.user_id || resp.ilink_user_id || resp.data?.ilink_user_id || "",
        };

        loggedIn = true;
        break;
      }

      // 尝试纯文本 token（32位 hex）
      if (resp._raw && /^[a-f0-9]{32}$/i.test(resp._raw.trim())) {
        console.log("✅ 登录成功！（纯文本 token）");
        loginResult = { botToken: resp._raw.trim(), accountId: "wechat-bot", baseUrl, userId: "" };
        loggedIn = true;
        break;
      }

      // 归一化状态值（trim + 小写，防止空字符/大小写导致匹配失败）
      const rawStatus = resp.status || resp.qrcode_status || "";
      const status = (typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : String(rawStatus || ""));
      logger.info("wechat-auth", `QR 状态: ${status}`, JSON.stringify(resp).slice(0, 200));

      switch (status) {
        case "confirmed":
          // 即使 gotToken 为假，confirmed 也应该有 token
          // 如果没有 token 但状态是 confirmed，说明响应格式异常
          if (!gotToken) {
            logger.warn("wechat-auth", "confirmed 状态但无 bot_token，完整响应", JSON.stringify(resp).slice(0, 500));
            console.log("⚠️  扫码已确认，但未获取到 token，继续等待...");
          }
          // gotToken 已在上面的 if 分支处理并 break，这里不需要再做
          break;

        case "wait":
          break;

        case "scaned":
        case "scanned":
          console.log("👀 已扫码，请在手机上确认登录...");
          logger.info("wechat-auth", "用户已扫码，等待确认");
          break;

        case "need_verifycode":
          console.log("⚠️  需要验证码，请在手机上完成验证");
          logger.info("wechat-auth", "需要验证码");
          break;

        case "expired":
          console.log("⏰ 二维码已过期，重新获取...");
          logger.info("wechat-auth", "二维码过期，刷新中...");
          refreshCount++;
          if (refreshCount > QR_REFRESH_MAX) {
            throw new Error("二维码过期次数过多，请重试");
          }
          loggedIn = true; // 跳出内循环，重新获取二维码
          // 过期后等待冷却再刷新，避免洪水
          await sleep(QR_REFRESH_DELAY_MS);
          break;

        case "scaned_but_redirect":
          console.log("🔄 IDC 切换中，请稍候...");
          logger.info("wechat-auth", "IDC 重定向");
          break;

        default:
          // 非标准状态也等一下，防止未知快速响应导致洪水
          console.log(`⚠️  未知状态: "${status}"，继续等待...`);
          logger.warn("wechat-auth", `未知 QR 状态: ${status}`, JSON.stringify(resp).slice(0, 300));
          break;
      }

      // ★ 关键：每次轮询后延迟，防止 API 秒回时造成洪水
      if (!loggedIn) {
        await sleep(QR_POLL_DELAY_MS);
      }
    }

    if (loginResult) {
      return loginResult;
    }
    // 否则继续外循环（二维码过期刷新）
  }
}
