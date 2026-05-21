/**
 * src/messages.js — 消息处理与媒体调度
 *
 * 职责：
 *   - processOneMessage: 单条消息的完整处理管线
 *   - pendingMedia: 图片暂存等待文字合并
 */

import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import {
  sendMessage,
  extractTextFromItemList,
  MessageItemType,
} from "../wechat-api.js";
import { extractImageFromItems } from "../cdn.js";
import { setContextToken } from "../session-store.js";
import { handleSlashCommand, cmdContext, userPrefs } from "./commands.js";
import { sendToAgentWithReply } from "./agent.js";
import { ACCOUNT_ID, PENDING_MEDIA_TIMEOUT_MS } from "./constants.js";

// ======== 待发送媒体暂存 ========

/**
 * pendingMedia: userId → { parts, contextToken, timer }
 * 图片到达后暂存 60 秒，等文字拼合；超时则单独发送
 */
const pendingMedia = new Map();

// ======== 处理单条消息 ========

export async function processOneMessage(msg, { token, baseUrl }) {
  const fromUserId = msg.from_user_id;
  if (!fromUserId) {
    logger.warn("messages", "消息缺少 from_user_id，跳过");
    return;
  }

  // allowFrom 白名单检查
  const allowFrom = getConfig().allowFrom;
  if (allowFrom.length > 0 && !allowFrom.includes(fromUserId)) {
    logger.info("messages", `用户不在白名单中，跳过`, { from: fromUserId });
    return;
  }

  const textBody = extractTextFromItemList(msg.item_list).trim();
  const contextToken = msg.context_token;

  // / 命令拦截
  if (textBody.startsWith("/")) {
    console.log(`📩 收到: ${textBody.slice(0, 80)}`);
    const reply = await handleSlashCommand(textBody, fromUserId, { token, baseUrl, contextToken });
    if (reply) {
      const preview = reply.slice(0, 60).replace(/\n/g, "\\n");
      console.log(`💬 回复: ${preview}${reply.length > 60 ? "..." : ""}`);
      await sendMessage({ baseUrl, token, toUserId: fromUserId, text: reply, contextToken });
    }
    return;
  }

  // 非 / 命令的普通消息：检查是否有等待中的交互上下文（如 /model 选择）
  const pendingCmd = cmdContext.get(fromUserId);
  if (pendingCmd && pendingCmd.cmd === "model") {
    // 用户在 /model 交互模式中，把这条消息当作模型选择处理
    console.log(`📩 收到模型选择: ${textBody.slice(0, 80)}`);
    const ctx = pendingCmd;
    const choice = textBody.trim();
    // 严格数字判断
    if (choice !== "" && !isNaN(Number(choice))) {
      const idx = parseInt(choice) - 1;
      if (idx >= 0 && idx < ctx.data.length) {
        const chosen = ctx.data[idx];
        userPrefs.set(fromUserId, { ...userPrefs.get(fromUserId), model: chosen.id });
        cmdContext.delete(fromUserId);
        await sendMessage({ baseUrl, token, toUserId: fromUserId, text: `模型已切换为 ${chosen.id}\n(${chosen.name || chosen.id})`, contextToken });
        return;
      }
      await sendMessage({ baseUrl, token, toUserId: fromUserId, text: `序号超出范围 (1-${ctx.data.length})，请重新输入`, contextToken });
      return;
    }
    // 非数字 → 名称匹配
    const match = ctx.data.find(m => m.id === choice || m.name === choice || m.id.endsWith("/" + choice));
    if (match) {
      userPrefs.set(fromUserId, { ...userPrefs.get(fromUserId), model: match.id });
      cmdContext.delete(fromUserId);
      await sendMessage({ baseUrl, token, toUserId: fromUserId, text: `模型已切换为 ${match.id}`, contextToken });
      return;
    }
    await sendMessage({ baseUrl, token, toUserId: fromUserId, text: `未找到 "${choice}"，请重试 (/model 重新列表，或输入其他命令如 /help)`, contextToken });
    return;
  }
  // 清除残留的交互上下文
  if (cmdContext.has(fromUserId)) {
    cmdContext.delete(fromUserId);
  }

  console.log(`📩 收到: ${textBody.slice(0, 80)}${textBody.length > 80 ? "..." : ""}`);

  // ======== 媒体处理 ========

  const hasImage = msg.item_list?.some(i => i.type === MessageItemType.IMAGE) ?? false;
  const hasFile = msg.item_list?.some(i => i.type === MessageItemType.FILE) ?? false;
  const hasVideo = msg.item_list?.some(i => i.type === MessageItemType.VIDEO) ?? false;

  // 文件/视频暂不支持
  if (hasFile || hasVideo) {
    logger.info("messages", "收到文件/视频消息，暂不支持", { from: fromUserId });
    await sendMessage({ baseUrl, token, toUserId: fromUserId, text: "暂不支持文件/视频消息，请发送文字或图片 😊", contextToken });
    return;
  }

  // 图片处理：下载 → 暂存 → 等文字 / 超时单独发送
  if (hasImage) {
    try {
      const imageData = await extractImageFromItems(msg.item_list);
      if (!imageData) {
        await sendMessage({ baseUrl, token, toUserId: fromUserId, text: "图片下载失败，请重试 😔", contextToken });
        return;
      }

      const mediaParts = [{ type: "file", mime: imageData.mime, url: imageData.dataUrl }];
      logger.info("messages", "📷 图片已暂存", { from: fromUserId, sizeKB: Math.round(imageData.buffer.length / 1024), mime: imageData.mime });

      // 保存 context_token
      if (contextToken) {
        setContextToken(ACCOUNT_ID, fromUserId, contextToken);
      }

      // 如果同一条消息里有文字，立即合并发送
      if (textBody.trim()) {
        await sendToAgentWithReply(fromUserId, textBody, mediaParts, { token, baseUrl, contextToken });
        return;
      }

      // 只有图片，暂存等待文字
      if (pendingMedia.has(fromUserId)) {
        clearTimeout(pendingMedia.get(fromUserId).timer);
      }

      const timer = setTimeout(() => {
        const media = pendingMedia.get(fromUserId);
        if (!media) return;
        pendingMedia.delete(fromUserId);
        logger.debug("messages", "图片超时，单独发送给 AI", { from: fromUserId });
        sendToAgentWithReply(fromUserId, "用户发送了一张图片", media.parts, { token, baseUrl, contextToken: media.contextToken })
          .catch(err => logger.error("messages", "图片超时发送失败", err));
      }, PENDING_MEDIA_TIMEOUT_MS);

      pendingMedia.set(fromUserId, { parts: mediaParts, contextToken, timer });
      return;

    } catch (err) {
      logger.error("messages", "图片处理失败", err);
      await sendMessage({ baseUrl, token, toUserId: fromUserId, text: `图片处理失败：${err.message.slice(0, 80)}`, contextToken });
      return;
    }
  }

  // ======== 纯文字消息 ========

  // 检查是否有暂存的图片等待合并
  if (textBody.trim() && pendingMedia.has(fromUserId)) {
    const media = pendingMedia.get(fromUserId);
    clearTimeout(media.timer);
    pendingMedia.delete(fromUserId);
    if (contextToken) {
      setContextToken(ACCOUNT_ID, fromUserId, contextToken);
    }
    logger.debug("messages", "🖼️📝 文字+图片合并发送", { from: fromUserId });
    await sendToAgentWithReply(fromUserId, textBody, media.parts, { token, baseUrl, contextToken });
    return;
  }

  // 空文字且无媒体 → 跳过
  if (!textBody.trim()) {
    logger.debug("messages", "空消息，跳过");
    return;
  }

  // 保存 context_token（用于后续主动发消息）
  if (contextToken) {
    setContextToken(ACCOUNT_ID, fromUserId, contextToken);
  }

  // 调用 agent 并回复（纯文字消息走这里）
  await sendToAgentWithReply(fromUserId, textBody, [], { token, baseUrl, contextToken });
}
