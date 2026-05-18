/**
 * cdn.js — 微信 CDN 媒体下载 + AES-128-ECB 解密
 *
 * 微信 iLink 的图片/文件/视频/语音都存储在 CDN 上，
 * 经过 AES-128-ECB + PKCS7 加密。需要：
 *   1. 从 CDN 下载加密数据
 *   2. 用 aes_key 解密
 *
 * AES key 有三种格式：
 *   A) base64(原始 16 字节) → 如 ABEiM0RVZneImaq7zN3u/w==
 *   B) base64(hex 字符串) → 解出来是 32 字符 hex，再转 16 字节
 *   C) 直接 hex 字符串 (32 字符) → 如 00112233445566778899aabbccddeeff
 */

import { createDecipheriv } from "node:crypto";
import { logger } from "./logger.js";
import { getConfig } from "./config.js";

const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const MAX_MEDIA_SIZE = 10 * 1024 * 1024; // 10MB 原始文件上限

// ======== AES 密钥解析 ========

/**
 * 解析 AES key，自动识别三种格式
 * @param {string} key - 原始 key 字符串
 * @returns {Buffer|null} 16 字节 AES key，解析失败返回 null
 */
function parseAesKey(key) {
  if (!key || typeof key !== "string") return null;

  // Format C: 直接 hex 字符串 (32 字符 = 16 字节)
  if (/^[0-9a-fA-F]{32}$/.test(key)) {
    return Buffer.from(key, "hex");
  }

  // 尝试 base64 解码
  let raw;
  try {
    raw = Buffer.from(key, "base64");
  } catch {
    return null;
  }

  // Format B: base64 解码后是 hex 字符串
  const asText = raw.toString("utf-8");
  if (/^[0-9a-fA-F]{32}$/.test(asText)) {
    return Buffer.from(asText, "hex");
  }

  // Format A: base64 解码后直接是 16 字节 key
  if (raw.length === 16) {
    return raw;
  }

  return null;
}

// ======== AES-128-ECB 解密 ========

/**
 * AES-128-ECB + PKCS7 解密
 * @param {Buffer} encrypted - 加密数据
 * @param {Buffer} key - 16 字节 AES key
 * @returns {Buffer} 解密数据
 */
function decryptAesEcb(encrypted, key) {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// ======== CDN 下载 ========

/**
 * 从微信 CDN 下载加密媒体并解密
 * @param {object} params
 * @param {string} params.encryptQueryParam - CDN 下载参数
 * @param {string} params.aesKey - AES 加密 key（各种格式）
 * @param {string} [params.cdnBaseUrl] - CDN 基础 URL（默认使用配置值）
 * @returns {Promise<Buffer>} 解密后的媒体数据
 */
export async function downloadAndDecrypt({ encryptQueryParam, aesKey, cdnBaseUrl }) {
  const baseUrl = cdnBaseUrl || getConfig().wechatCdnBaseUrl || DEFAULT_CDN_BASE_URL;
  const key = parseAesKey(aesKey);

  if (!key) {
    throw new Error(`无法解析 AES key: ${(aesKey || "").slice(0, 20)}...`);
  }

  const url = `${baseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  logger.info("cdn", "下载加密媒体", { url: url.slice(0, 100) });

  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    throw new Error(`CDN 下载失败: HTTP ${res.status}`);
  }

  const encrypted = Buffer.from(await res.arrayBuffer());

  if (encrypted.length === 0) {
    throw new Error("CDN 加密数据为空（URL 可能已过期）");
  }

  logger.info("cdn", "加密数据已下载", { size: encrypted.length });

  if (encrypted.length > MAX_MEDIA_SIZE * 1.5) {
    // 1.5x 是加密后的膨胀上限
    throw new Error(`媒体文件过大 (${(encrypted.length / 1024 / 1024).toFixed(1)}MB)，跳过`);
  }

  const decrypted = decryptAesEcb(encrypted, key);
  if (decrypted.length === 0) {
    throw new Error("解密后数据为空");
  }
  logger.info("cdn", "解密完成", { size: decrypted.length });

  return decrypted;
}

/**
 * 通过直接 URL 下载媒体（不需要解密，如 image_item.media.full_url）
 * @param {string} url - 直接下载 URL
 * @returns {Promise<Buffer>} 原始媒体数据
 */
export async function downloadDirect(url) {
  logger.info("cdn", "直接下载媒体", { url: url.slice(0, 100) });

  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    throw new Error(`直接下载失败: HTTP ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  // 空响应检查：CDN URL 过期或重定向到错误页面时可能返回 0 字节或非图片内容
  if (buffer.length === 0) {
    throw new Error("直接下载返回空数据（CDN URL 可能已过期）");
  }
  if (buffer.length > MAX_MEDIA_SIZE) {
    throw new Error(`媒体文件过大 (${(buffer.length / 1024 / 1024).toFixed(1)}MB)，跳过`);
  }

  logger.info("cdn", "直接下载完成", { size: buffer.length });
  return buffer;
}

// ======== 工具函数 ========

/**
 * 从 CDN URL 中提取 encrypted_query_param 的值
 * 如 https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=UEkx...
 * @param {string} url - 包含加密参数的 URL
 * @returns {string|null} 提取出的参数值
 */
function extractEncryptParam(url) {
  if (!url) return null;
  // 匹配 encrypted_query_param= 后面的值（到 & 或串尾）
  const m = url.match(/[?&]encrypted_query_param=([^&]+)/i);
  return m ? m[1] : null;
}

/**
 * 从 Buffer 魔数检测图片 MIME 类型
 * @param {Buffer} buffer - 图片原始数据
 * @returns {string} MIME 类型
 */
export function detectImageMime(buffer) {
  if (buffer.length < 4) return "image/jpeg";
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: 47 49 46
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer.length > 11 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return "image/webp";
  }
  return "image/jpeg";
}

/**
 * 从消息的 item_list 中提取并下载图片
 * 返回 { buffer, mime, dataUrl } 或 null
 * @param {Array} itemList - 消息的 item_list
 * @returns {Promise<{buffer: Buffer, mime: string, dataUrl: string}|null>}
 */
export async function extractImageFromItems(itemList) {
  if (!itemList?.length) return null;

  for (const item of itemList) {
    if (item.type !== 2) continue; // MessageItemType.IMAGE = 2
    const img = item.image_item;
    if (!img) continue;

    // 详细日志记录 image_item 结构以便调试
    logger.info("cdn", "图片下载 - image_item 结构", {
      url: img.url ? img.url.slice(0, 80) + "..." : null,
      hasMedia: !!img.media,
      mediaKeys: img.media ? Object.keys(img.media) : [],
      aeskey: img.aeskey ? img.aeskey.slice(0, 8) + "..." : (img.aes_key ? img.aes_key.slice(0, 8) + "..." : null),
      mediaAesKey: img.media?.aes_key ? img.media.aes_key.slice(0, 8) + "..." : null,
      imgKeys: Object.keys(img),
    });

    try {
      let buffer;

      // 检查 URL 是否是加密 CDN 链接（含 encrypted_query_param）
      const isEncryptedUrl = img.url && /encrypted[_-]query[_-]param/i.test(img.url);

      // 优先使用非加密的直接 URL（full_url 或不含加密参数的 url）
      if (img.url && !isEncryptedUrl) {
        // img.url 是真正的直接下载链接，不需要解密
        buffer = await downloadDirect(img.url);
      } else if (img.media?.full_url && !/encrypted[_-]query[_-]param/i.test(img.media.full_url)) {
        // media.full_url 是直接链接
        buffer = await downloadDirect(img.media.full_url);
      } else if (isEncryptedUrl || img.media?.encrypt_query_param) {
        // 加密 CDN 下载：从 URL 中提取 encrypt_query_param，或使用 media 的字段
        const encryptQueryParam = isEncryptedUrl
          ? extractEncryptParam(img.url)
          : img.media.encrypt_query_param;
        // aesKey 可能在 media.aes_key / img.aeskey / img.aes_key
        const aesKey = img.media?.aes_key || img.aeskey || img.aes_key;
        if (!aesKey) {
          logger.warn("cdn", "加密图片缺少 aes_key，跳过下载", {
            hasUrl: !!img.url,
            hasMedia: !!img.media,
            imageKeys: Object.keys(img),
            mediaKeys: img.media ? Object.keys(img.media) : [],
          });
          continue;
        }
        if (!encryptQueryParam) {
          logger.warn("cdn", "加密图片缺少 encrypt_query_param，跳过下载");
          continue;
        }
        buffer = await downloadAndDecrypt({
          encryptQueryParam,
          aesKey,
        });
      } else if (img.url) {
        // 有 url 但无法确定是否加密，尝试直接下载
        buffer = await downloadDirect(img.url);
      } else {
        logger.warn("cdn", "图片没有可用的下载方式", { imageKeys: Object.keys(img) });
        continue;
      }

      const mime = detectImageMime(buffer);

      // 验证图片数据有效性：至少要有正确的文件头魔数
      const isValidImage = (mime === "image/png" && buffer[0] === 0x89)
        || (mime === "image/jpeg" && buffer[0] === 0xff && buffer[1] === 0xd8)
        || (mime === "image/gif" && buffer[0] === 0x47)
        || (mime === "image/webp");
      if (!isValidImage) {
        logger.warn("cdn", "下载的数据不是有效图片格式", { mime, sizeBytes: buffer.length, header: buffer.slice(0, 8).toString("hex") });
        continue;
      }
      // 至少 100 字节才是有效图片（过小可能是损坏/空响应）
      if (buffer.length < 100) {
        logger.warn("cdn", "图片数据太小，可能损坏", { sizeBytes: buffer.length });
        continue;
      }

      const base64 = buffer.toString("base64");
      const dataUrl = `data:${mime};base64,${base64}`;

      logger.info("cdn", "图片下载成功", { mime, sizeKB: Math.round(buffer.length / 1024) });
      return { buffer, mime, dataUrl };
    } catch (err) {
      logger.error("cdn", "图片下载失败", err);
      // 继续尝试下一个图片 item
    }
  }

  return null;
}