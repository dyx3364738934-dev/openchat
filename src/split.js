/**
 * src/split.js — 长文本智能分段
 *
 * 在微信 4000 字限制下，尽量在自然断点处切分，
 * 保护代码块(```)和表格(|...)不被截断。
 */

import { WECHAT_TEXT_LIMIT } from "./constants.js";

/**
 * 智能找断点：在大段文本中找到自然的分割位置
 * 优先级：段落(\n\n) > 句号(。) > 换行(\n) > 逗号(，)
 * 保护代码块(```)和表格不被截断
 * @returns {number} 断点位置，-1 表示不够长不分
 */
export function findSmartSplit(text, minLen = 200) {
  if (text.length < minLen) return -1;

  // 检查代码块完整性：奇数个 ``` 表示正在代码块内
  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0) {
    // 代码块未闭合，等闭合后再切
    const closeIdx = text.indexOf("```", minLen);
    if (closeIdx !== -1) return closeIdx + 3;
    return -1; // 还没闭合，不分
  }

  // 检查表格行（以 | 开头的行），不在表格中间切
  const lastNewline = text.lastIndexOf("\n", minLen);
  const afterNewline = text.slice(lastNewline + 1, lastNewline + 20);
  if (afterNewline.trimStart().startsWith("|")) {
    // 在表格行内，退到上一个 \n\n
    const prevPara = text.lastIndexOf("\n\n", minLen - 1);
    if (prevPara > minLen / 2) return prevPara + 2;
    return -1;
  }

  // 1. 段落分隔（最优）
  const paraBreak = text.indexOf("\n\n", minLen);
  if (paraBreak !== -1 && paraBreak < minLen + 1000) return paraBreak + 2;

  // 2. 句子结束
  const sentenceRe = /[。！？\n](?![」』）\)\】\"\'\/\/])/;
  const sentenceMatch = text.slice(minLen).match(sentenceRe);
  if (sentenceMatch) return minLen + sentenceMatch.index + 1;

  // 3. 逗号/顿号
  const commaMatch = text.slice(minLen).match(/[，、；]/);
  if (commaMatch) return minLen + commaMatch.index + 1;

  // 4. 空格（英文）
  const spaceIdx = text.indexOf(" ", minLen);
  if (spaceIdx !== -1 && spaceIdx < minLen + 300) return spaceIdx + 1;

  // 5. 文本太长了，硬切
  if (text.length > 800) return minLen;

  return -1;
}

/**
 * 将长文本按微信消息限制分割
 * 尽量在换行处分割，避免截断代码块（保持 ``` 配对）
 */
export function splitLongText(text, limit = WECHAT_TEXT_LIMIT) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > limit) {
    // 在 limit 附近找最近的换行
    let splitAt = limit;
    const searchStart = Math.max(0, limit - 200);
    const nlIndex = remaining.lastIndexOf("\n", limit);
    if (nlIndex > searchStart) {
      splitAt = nlIndex + 1;
    }

    // 检查分割点前后是否在代码块内（未闭合的 ```）
    const beforeSplit = remaining.slice(0, splitAt);
    const fenceCount = (beforeSplit.match(/```/g) || []).length;
    // 奇数个 ``` 表示代码块未闭合，需要扩展到下一个闭合点
    if (fenceCount % 2 !== 0) {
      const closeIndex = remaining.indexOf("```", splitAt);
      if (closeIndex !== -1) {
        // 包含闭合 ``` 所在行的结尾
        const afterClose = remaining.indexOf("\n", closeIndex);
        splitAt = (afterClose !== -1 ? afterClose + 1 : closeIndex + 3);
      }
      // 找不到闭合点 → 不分割，看最终剩余是否超限（只能硬切）
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
