/**
 * src/constants.js — 共享常量
 */

/** 默认账户 ID，context_token 和 sync buffer 的作用域 */
export const ACCOUNT_ID = "default";

/** 微信单条消息文字上限 */
export const WECHAT_TEXT_LIMIT = 4000;

/** 图片暂存等待文字描述的过期时间（毫秒） */
export const PENDING_MEDIA_TIMEOUT_MS = 60_000;

/** 有效 / 命令列表（不含交互子命令） */
export const VALID_COMMANDS = new Set(["reset", "status", "model", "agent", "help"]);
