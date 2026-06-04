/**
 * src/agent.js — AI 调用与错误翻译
 *
 * 职责：
 *   - sendToAgentWithReply: 统一的发消息 → 收回复 → Markdown 过滤 → 分段发送流程
 *   - friendlyError: 技术错误 → 用户友好消息
 */

import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import { sendToAgent, sendToAgentStreaming } from "../opencode-client.js";
import { StreamingMarkdownFilter } from "../markdown-filter.js";
import {
  sendMessage,
  getConfig as getWechatConfig,
  sendTyping,
  TypingStatus,
} from "../wechat-api.js";
import { markBrokenModel } from "./models.js";
import { splitLongText, findSmartSplit } from "./split.js";
import { userPrefs } from "./commands.js";

// ======== 工具 ========

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ======== 错误信息翻译 ========

/**
 * 把 OpenCode API 的技术错误翻译成用户友好但内行秒懂的消息
 * 保留 HTTP 状态码供技术人员排查
 */
export function friendlyError(err, model) {
  const msg = err.message;
  const modelHint = model ? `（当前模型: ${model}）` : "";

  // HTTP 状态码映射
  if (/HTTP 400/i.test(msg)) {
    // 400: 请求格式错误（可能缺字段、data URL 无效等）
    const detail = /missing key/i.test(msg) ? "请求缺少必要字段" : "请求格式有误";
    return `请求被拒绝 — ${detail}${modelHint}\n技术详情: ${msg.slice(0, 200)}`;
  }
  if (/HTTP 401/i.test(msg)) {
    return `认证失败 — 请检查 OpenCode 服务是否正常运行${modelHint}\n技术详情: ${msg.slice(0, 200)}`;
  }
  if (/HTTP 402/i.test(msg)) {
    return `额度不足 — 该模型可能需要付费订阅${modelHint}\n技术详情: ${msg.slice(0, 200)}`;
  }
  if (/HTTP 429/i.test(msg)) {
    return `请求过于频繁 — 请稍后再试${modelHint}\n技术详情: ${msg.slice(0, 200)}`;
  }
  if (/HTTP 500/i.test(msg)) {
    // 500: 模型服务端错误（模型不可用、上游挂了等）
    if (/qwen.*3\.6|qwen3\.6/i.test(msg) || /qwen.*3\.6|qwen3\.6/i.test(model || "")) {
      return `Qwen 3.6 模型目前不可用 — 上游阿里云服务异常，这是 OpenCode 已知问题（#24088, #21455）\n建议用 /model 切换到其他模型${modelHint}`;
    }
    if (/free promotion has ended|免费/i.test(msg)) {
      return `该免费模型已结束免费期${modelHint}\n建议用 /model 切换到其他模型\n技术详情: ${msg.slice(0, 200)}`;
    }
    return `模型服务出错 — 服务端内部错误，可能是模型暂时不可用${modelHint}\n建议用 /model 切换模型后重试\n技术详情: ${msg.slice(0, 200)}`;
  }
  if (/HTTP 502|HTTP 503/i.test(msg)) {
    return `模型服务暂时不可用 — 请稍后重试${modelHint}\n技术详情: ${msg.slice(0, 200)}`;
  }
  if (/agent timeout/i.test(msg)) {
    return `模型响应超时（10分钟）— 可能是模型负载高或网络不稳${modelHint}\n建议用 /model 切换模型`;
  }
  if (/session create/i.test(msg)) {
    return `创建会话失败 — 可能是模型不可用或服务异常${modelHint}\n技术详情: ${msg.slice(0, 200)}`;
  }

  // 模型不支持图片
  if (/does not support|not support|cannot accept|no.*image|no.*vision|no.*multimodal|modalities/i.test(msg)) {
    return `当前模型不支持图片输入${modelHint}\n建议: 用 /model 切换到支持视觉的模型（如 gemini-2.5-flash）`;
  }

  // 兜底
  return `处理消息出错${modelHint}\n技术详情: ${msg.slice(0, 150)}`;
}

// ======== 调用 Agent 并回复 ========

/**
 * 统一的发消息 → 收回复 → 过滤 → 发送流程
 * 支持图片回退：如果模型返回 400 等错误（不支持图片），自动用文字描述重试
 */
export async function sendToAgentWithReply(userId, text, mediaParts, { token, baseUrl, contextToken }) {
  // 尝试获取 typing_ticket 并发送"正在输入…"
  let typingTicket = null;
  try {
    const config = await getWechatConfig({
      baseUrl,
      token,
      ilinkUserId: userId,
      contextToken,
    });
    typingTicket = config.typing_ticket;
    if (typingTicket) {
      await sendTyping({
        baseUrl,
        token,
        ilinkUserId: userId,
        typingTicket,
        status: TypingStatus.TYPING,
      }).catch(() => {});
    }
  } catch (err) {
    logger.debug("agent", "获取 typing_ticket 失败（非关键）", err);
  }

  const startTime = Date.now();

  try {
    // 调用 OpenCode agent（优先流式，失败回退同步）
    const cfg = getConfig();
    const prefs = userPrefs.get(userId) || {};
    const currentModel = prefs.model || cfg.opencodeModel || "deepseek-v4-pro";
    const agentOpts = {};
    logger.debug("agent", `🤖 调用 agent (streaming)`, { from: userId, hasMedia: mediaParts.length > 0, model: currentModel });

    let result;
    let lastSentLen = 0; // 已发送到微信的文本长度

    try {
      // 轮询模式：每 2 秒拉一次回复，智能分块发送
      result = await sendToAgentStreaming(userId, text, { ...prefs, ...agentOpts }, mediaParts, {
        onDelta: (fullText) => {
          // 计算出还没发送的新文本
          const newText = fullText.slice(lastSentLen);
          if (!newText) return;

          // 找自然断点
          const splitAt = findSmartSplit(newText);
          if (splitAt <= 0) return; // 还不够多，不切

          const chunk = newText.slice(0, splitAt);
          const mf = new StreamingMarkdownFilter();
          const filtered = mf.feed(chunk) + mf.flush();
          lastSentLen += splitAt;

          // 异步发送，不阻塞轮询
          sendMessage({ baseUrl, token, toUserId: userId, text: filtered, contextToken })
            .catch(err => logger.warn("agent", "onDelta sendMessage 失败", { to: userId, err: err.message?.slice(0, 80) }));
        },
      });
    } catch (streamErr) {
      logger.info("agent", "流式发送失败，回退同步", { err: streamErr.message });
      result = await sendToAgent(userId, text, { ...prefs, ...agentOpts }, mediaParts);
    }
    const aiMs = Date.now() - startTime;

    // 如果 AI 返回空回复且 onDelta 也没发送过任何内容，给用户一个提示
    const totalText = result.text || "";
    if (totalText.trim().length === 0 && lastSentLen === 0) {
      logger.warn("agent", "AI 返回空回复", { from: userId, model: currentModel });
      await sendMessage({ baseUrl, token, toUserId: userId, text: "（AI 返回了空回复，可能是模型暂时未就绪，请稍后重试）", contextToken });
      console.log(`⚠️ 空回复 → ${userId} (${aiMs}ms)`);
      // typing ticket 由外层 finally 清理
      return;
    }

    // 发送剩余未发送的文本（最后一块）
    const remaining = result.text.slice(lastSentLen);
    if (remaining.trim()) {
      const filter = new StreamingMarkdownFilter();
      const filtered = filter.feed(remaining) + filter.flush();
      const chunks = splitLongText(filtered);
      for (let i = 0; i < chunks.length; i++) {
        await sendMessage({ baseUrl, token, toUserId: userId, text: chunks[i], contextToken });
        if (i < chunks.length - 1) await sleep(500);
      }
    }
    console.log(`✅ 回复已发送 → ${userId} (${aiMs}ms${lastSentLen > 0 ? ", 分" + Math.ceil(result.text.length / lastSentLen) + "段" : ""})`);
  } catch (err) {
    logger.error("agent", "处理消息失败", err);

    // 如果带图片发送失败，尝试降级为纯文字
    // 模型不支持图片、HTTP 400、视觉模型 500 等情况
    const isModelNotSupportImage = mediaParts.length > 0 && (
      /does not support|not support|cannot accept|no.*image|no.*vision|no.*multimodal|modalities|attachment.*not/i.test(err.message)
    );
    const isBadRequestWithMedia = mediaParts.length > 0 && /HTTP 400/i.test(err.message);
    const isServerErrWithMedia = mediaParts.length > 0 && /HTTP 5\d{2}/i.test(err.message);

    if (isModelNotSupportImage || isBadRequestWithMedia || isServerErrWithMedia) {
      logger.info("agent", "图片发送失败，降级为文字描述", { from: userId, reason: isModelNotSupportImage ? "模型不支持图片" : isBadRequestWithMedia ? "HTTP 400" : "服务端错误", errMsg: err.message.slice(0, 200) });
      const fallbackText = text.trim()
        ? `[用户发送了一张图片]\n${text}`
        : "[用户发送了一张图片，但当前模型不支持识别图片]";
      try {
        const prefs = userPrefs.get(userId) || {};
        const retryResult = await sendToAgent(userId, fallbackText, prefs);
        const filter = new StreamingMarkdownFilter();
        const filtered = filter.feed(retryResult.text) + filter.flush();
        const chunks = splitLongText(filtered);
        for (let i = 0; i < chunks.length; i++) {
          await sendMessage({ baseUrl, token, toUserId: userId, text: chunks[i], contextToken });
          if (i < chunks.length - 1) await sleep(500);
        }
        console.log(`✅ 回复已发送（图片回退） → ${userId}`);
        return;
      } catch (retryErr) {
        logger.error("agent", "图片回退重试也失败", retryErr);
        err = retryErr; // 替换外层的 err，确保通用错误处理上报正确的根因
      }
    }

    // 非图片的 500 错误：标记模型为坏模型，自动回退到默认模型重试
    const prefs = userPrefs.get(userId) || {};
    const currentModel = prefs.model || getConfig().opencodeModel || "deepseek-v4-pro";
    if (/HTTP 5\d{2}/i.test(err.message) && mediaParts.length === 0 && currentModel) {
      markBrokenModel(currentModel);

      // 如果当前不是默认模型，自动回退重试一次
      const defaultModel = getConfig().opencodeModel || "deepseek-v4-pro";
      if (currentModel !== defaultModel) {
        try {
          logger.info("agent", "模型 500 错误，自动回退到默认模型重试", { from: userId, failedModel: currentModel, fallbackModel: defaultModel });
          const retryResult = await sendToAgent(userId, text, { model: defaultModel });
          const filter = new StreamingMarkdownFilter();
          const filtered = filter.feed(retryResult.text) + filter.flush();
          const chunks = splitLongText(filtered);
          for (let i = 0; i < chunks.length; i++) {
            await sendMessage({ baseUrl, token, toUserId: userId, text: chunks[i], contextToken });
            if (i < chunks.length - 1) await sleep(500);
          }
          await sendMessage({ baseUrl, token, toUserId: userId, text: `💡 模型 ${currentModel} 不可用，已自动切换到 ${defaultModel}`, contextToken });
          console.log(`✅ 回复已发送（500 回退） → ${userId}`);
          return;
        } catch (retryErr) {
          logger.error("agent", "回退到默认模型也失败", retryErr);
        }
      }
    }

    console.error(`❌ 回复失败 → ${userId}: ${err.message}`);

    try {
      const userMsg = friendlyError(err, currentModel);
      await sendMessage({
        baseUrl,
        token,
        toUserId: userId,
        text: `⚠️ ${userMsg}`,
        contextToken,
      });
    } catch {
      // 连错误提示都发不出去就算了
    }
  } finally {
    // 确保进度提示也被清除
    if (typingTicket) {
      await sendTyping({
        baseUrl,
        token,
        ilinkUserId: userId,
        typingTicket,
        status: TypingStatus.CANCEL,
      }).catch(() => {});
    }
  }
}
