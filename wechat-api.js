/**
 * wechat-api.js — 微信机器人 API 封装
 *
 * 所有端点的基础地址：https://ilinkai.weixin.qq.com
 * 认证方式：HTTP Header AuthorizationType: ilink_bot_token + Bearer <token>
 * 通用请求头：iLink-App-Id: bot, iLink-App-ClientVersion, X-WECHAT-UIN
 *
 * 8 个 API 端点：
 *   1. getUpdates          — 长轮询收消息 (POST /ilink/bot/getupdates)
 *   2. sendMessage         — 发文字消息     (POST /ilink/bot/sendmessage)
 *   3. getUploadUrl        — 获取 CDN 上传凭证 (POST /ilink/bot/getuploadurl)
 *   4. getConfig           — 获取 typing_ticket (POST /ilink/bot/getconfig)
 *   5. sendTyping          — 发送/取消"正在输入" (POST /ilink/bot/sendtyping)
 *   6. notifyStart         — 通知网关启动    (POST /ilink/bot/msg/notifystart)
 *   7. notifyStop          — 通知网关关闭    (POST /ilink/bot/msg/notifystop)
 *   8. (QR 相关在 wechat-auth.js)
 */

import crypto from "node:crypto";
import { logger } from "./logger.js";
import { getConfig as getAppConfig } from "./config.js";

// ======== 协议常量 ========

/** MessageItem 内容类型 */
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
};

/** 消息类型 */
export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
};

/** 消息状态 */
export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
};

/** 上传媒体类型 */
export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
};

/** Typing 状态 */
export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
};

/** iLink App 常量（从 openclaw-weixin 的 package.json 提取） */
export const ILINK_APP_ID = "bot";
export const CHANNEL_VERSION = "2.4.1";

/** 将版本号 "2.4.1" 编码为 uint32: 0x00020401 */
export function buildClientVersion(version) {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION);

// ======== 请求构建 ========

/** 确保 URL 以 / 结尾 */
function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

/** 生成随机 X-WECHAT-UIN（uint32 的 base64 编码） */
function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  // 生成 8 字节随机值以增加熵，base64 编码约 12 字符
  return Buffer.from(String(uint32 % 100000000 + 100000000)).toString("base64");
}

/** 构建 base_info（每个请求体都要带） */
function buildBaseInfo() {
  const { botAgent } = getAppConfig();
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: botAgent || "OpenChat/2.0",
  };
}

/** 构建通用请求头 */
function buildHeaders({ token }) {
  const headers = {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

// ======== HTTP 请求封装 ========

/**
 * POST JSON 到微信 API
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {string} params.endpoint  例如 "ilink/bot/getupdates"
 * @param {object} params.body      JSON 对象（自动序列化）
 * @param {string} [params.token]
 * @param {number} [params.timeoutMs]
 * @param {string} params.label     日志标签
 * @returns {Promise<string>} 原始响应文本
 */
async function apiPost(params) {
  const { baseUrl, endpoint, body, token, timeoutMs, label } = params;
  const base = ensureTrailingSlash(baseUrl);
  const url = new URL(endpoint, base).toString();
  const bodyStr = JSON.stringify({ ...body, base_info: buildBaseInfo() });
  const headers = buildHeaders({ token });

  const controller = timeoutMs > 0 ? new AbortController() : null;
  // 用于标识此次 abort 是否来自超时
  let timedOut = false;
  const timer = controller
    ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs)
    : null;

  try {
    logger.debug("wechat-api", `POST ${label}`, { url, bodySize: bodyStr.length });

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller?.signal,
    });

    if (timer) clearTimeout(timer);
    const rawText = await res.text();

    if (!res.ok) {
      logger.error("wechat-api", `${label} HTTP ${res.status}`, rawText.slice(0, 200));
      throw new Error(`${label} HTTP ${res.status}: ${rawText.slice(0, 100)}`);
    }

    return rawText;
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (err.name === "AbortError") {
      // 标记是否来自超时 timer，便于调用方区分正常超时和外部中断
      err._timeout = timedOut;
      throw err;
    }
    throw err;
  }
}

// ======== API 端点实现 ========

/**
 * 1. getUpdates — 长轮询收消息
 * 服务端 hold 连接直到有新消息或超时（默认 35s）
 * 超时时返回空消息列表，调用方直接重试即可
 */
export async function getUpdates({ baseUrl, token, getUpdatesBuf, timeoutMs }) {
  try {
    const rawText = await apiPost({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: { get_updates_buf: getUpdatesBuf ?? "" },
      token,
      timeoutMs: timeoutMs ?? 35000,
      label: "getUpdates",
    });
    return JSON.parse(rawText);
  } catch (err) {
    if (err.name === "AbortError" && err._timeout) {
      // 来自超时控制器的 abort（长轮询超时），是正常行为，返回空结果
      logger.debug("wechat-api", "getUpdates 客户端超时，返回空结果");
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

/**
 * 2. sendMessage — 发送消息
 */
export async function sendMessage({ baseUrl, token, toUserId, text, contextToken }) {
  const clientId = crypto.randomBytes(8).toString("hex");
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: text
        ? [{ type: MessageItemType.TEXT, text_item: { text } }]
        : [],
      context_token: contextToken ?? undefined,
    },
  };

  await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body,
    token,
    timeoutMs: 15000,
    label: "sendMessage",
  });

  logger.info("wechat-api", `消息已发送`, { to: toUserId, textLen: text?.length ?? 0, clientId });
  return { messageId: clientId };
}

/**
 * 3. getUploadUrl — 获取 CDN 上传预签名 URL
 */
export async function getUploadUrl({ baseUrl, token, ...uploadParams }) {
  const rawText = await apiPost({
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: uploadParams,
    token,
    timeoutMs: 15000,
    label: "getUploadUrl",
  });
  return JSON.parse(rawText);
}

/**
 * 4. getConfig — 获取 bot 配置（含 typing_ticket）
 */
export async function getConfig({ baseUrl, token, ilinkUserId, contextToken }) {
  const rawText = await apiPost({
    baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: {
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
    },
    token,
    timeoutMs: 10000,
    label: "getConfig",
  });
  return JSON.parse(rawText);
}

/**
 * 5. sendTyping — 发送/取消"对方正在输入…"状态
 */
export async function sendTyping({ baseUrl, token, ilinkUserId, typingTicket, status }) {
  await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status: status ?? TypingStatus.TYPING,
    },
    token,
    timeoutMs: 10000,
    label: `sendTyping(${status === TypingStatus.TYPING ? "开始" : "取消"})`,
  });
}

/**
 * 6. notifyStart — 通知网关启动
 */
export async function notifyStart({ baseUrl, token }) {
  const rawText = await apiPost({
    baseUrl,
    endpoint: "ilink/bot/msg/notifystart",
    body: {},
    token,
    timeoutMs: 10000,
    label: "notifyStart",
  });
  return JSON.parse(rawText);
}

/**
 * 7. notifyStop — 通知网关关闭
 */
export async function notifyStop({ baseUrl, token }) {
  try {
    const rawText = await apiPost({
      baseUrl,
      endpoint: "ilink/bot/msg/notifystop",
      body: {},
      token,
      timeoutMs: 10000,
      label: "notifyStop",
    });
    return JSON.parse(rawText);
  } catch (err) {
    // 关闭通知失败不影响退出
    logger.warn("wechat-api", "notifyStop 失败（忽略）", err);
    return { ret: -1 };
  }
}

// ======== 工具函数 ========

/** 从 item_list 中提取文字内容（拼接所有文本和语音转文字项） */
export function extractTextFromItemList(itemList) {
  if (!itemList?.length) return "";
  const parts = [];
  for (const item of itemList) {
    // 纯文本
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) {
        parts.push(text);
        continue;
      }
      // 引用消息
      const refParts = [];
      if (ref.title) refParts.push(ref.title);
      if (ref.message_item) {
        const refBody = extractTextFromItemList([ref.message_item]);
        if (refBody) refParts.push(refBody);
      }
      parts.push(refParts.length ? `[引用: ${refParts.join(" | ")}]\n${text}` : text);
    }
    // 语音转文字
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      parts.push(item.voice_item.text);
    }
  }
  return parts.join("\n");
}

/** 检查是否有媒体文件需要下载 */
export function hasDownloadableMedia(itemList) {
  if (!itemList?.length) return false;
  return itemList.some((item) => {
    if (item.type === MessageItemType.IMAGE) return !!item.image_item?.media?.encrypt_query_param || !!item.image_item?.media?.full_url;
    if (item.type === MessageItemType.VIDEO) return !!item.video_item?.media?.encrypt_query_param || !!item.video_item?.media?.full_url;
    if (item.type === MessageItemType.FILE) return !!item.file_item?.media?.encrypt_query_param || !!item.file_item?.media?.full_url;
    if (item.type === MessageItemType.VOICE) return !!item.voice_item?.media?.encrypt_query_param || !!item.voice_item?.media?.full_url;
    return false;
  });
}
