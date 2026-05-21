/**
 * src/models.js — 模型管理全栈
 *
 * 职责：
 *   - 坏模型持久化缓存（load/save/markBrokenModels）
 *   - 免费模型启动验证（probeFreeModels）
 *   - 模型列表拉取与筛选（fetchRawModels, fetchAvailableModels）
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";
import { getConfig } from "../config.js";
import { getOpenCodePort, getOpenCodeAuth } from "../opencode-client.js";

// ======== 坏模型持久化缓存 ========

// __dirname 在 src/ 下，需要上一级回到项目根
const __dir = dirname(fileURLToPath(import.meta.url));
const BROKEN_MODELS_FILE = resolve(__dir, "..", "broken-models.json");

/** 从文件加载坏模型列表 */
export function loadBrokenModels() {
  try {
    if (existsSync(BROKEN_MODELS_FILE)) {
      const data = JSON.parse(readFileSync(BROKEN_MODELS_FILE, "utf-8"));
      const set = new Set(data);
      if (set.size > 0) console.log(`📋 已加载 ${set.size} 个坏模型缓存`);
      return set;
    }
  } catch {}
  return new Set();
}

/** 保存坏模型列表到文件 */
export function saveBrokenModels(set) {
  try {
    writeFileSync(BROKEN_MODELS_FILE, JSON.stringify([...set], null, 2), "utf-8");
  } catch (err) {
    logger.warn("models", "保存坏模型缓存失败", err.message);
  }
}

/** 标记模型为坏模型（运行时 500 时调用） */
export function markBrokenModel(modelId) {
  const broken = loadBrokenModels();
  if (!broken.has(modelId)) {
    broken.add(modelId);
    saveBrokenModels(broken);
    logger.info("models", "🚫 模型标记为不可用并缓存", { model: modelId });
    console.log(`🚫 模型 ${modelId} 返回 500，已加入坏模型缓存`);
  }
}

// ======== 模型探测 ========

/**
 * 探测免费模型可用性（直接从 API 获取原始列表，包含 broken 模型）
 * 这样可以发现之前坏掉但现已恢复的模型，从 broken 列表中移除
 * 只测创建 session（不发消息），401/403 不标记为坏模型
 */
export async function probeFreeModels() {
  const port = await getOpenCodePort();
  const auth = getOpenCodeAuth();
  if (!port) return;

  // 直接从 API 获取原始模型列表，不过滤 broken
  const rawModels = await fetchRawModels();
  const freeModels = rawModels.filter(m => m.free);
  if (freeModels.length === 0) return;

  console.log(`🔍 正在验证 ${freeModels.length} 个免费模型可用性...`);
  const broken = loadBrokenModels();
  let okCount = 0, recoveredCount = 0, failCount = 0, authSkipCount = 0;

  for (const m of freeModels) {
    const modelId = m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id;
    const providerID = m.id.includes("/") ? m.id.split("/")[0] : "opencode";

    try {
      // 只测创建 session 能否成功（不发消息，不消耗 token）
      const s = await fetch("http://127.0.0.1:" + port + "/session", {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "build", model: { id: modelId, providerID } }),
        signal: AbortSignal.timeout(5000),
      });
      if (s.ok) {
        const wasBroken = broken.has(m.id);
        if (wasBroken) {
          recoveredCount++;
          console.log(`  ♻️ ${m.id} — 已恢复！`);
        } else {
          okCount++;
          console.log(`  ✅ ${m.id}`);
        }
        broken.delete(m.id); // 从坏模型列表移除
        // 创建成功后立即删除 session，不浪费
        try {
          const session = await s.json();
          await fetch("http://127.0.0.1:" + port + "/session/" + encodeURIComponent(session.id), {
            method: "DELETE",
            headers: { Authorization: auth },
            signal: AbortSignal.timeout(3000),
          }).catch(() => {});
        } catch {}
      } else if (s.status === 401 || s.status === 403) {
        // 401/403 = 认证问题，不是模型本身的锅
        broken.delete(m.id); // 不标记为坏模型，让用户自己尝试
        authSkipCount++;
        console.log(`  ⏭️ ${m.id} — 认证受限 (${s.status})，跳过`);
      } else {
        // 500 等服务端错误 = 模型不可用
        broken.add(m.id);
        failCount++;
        console.log(`  🚫 ${m.id} — 不可用 (${s.status})`);
      }
    } catch (e) {
      // 超时或连接错误也标记为坏
      broken.add(m.id);
      failCount++;
      console.log(`  🚫 ${m.id} — 异常: ${e.message.slice(0, 50)}`);
    }
  }

  saveBrokenModels(broken);
  const total = okCount + recoveredCount + failCount + authSkipCount;
  console.log(`🔍 免费模型验证完成: ✅${okCount} ♻️${recoveredCount} 🚫${failCount} ⏭️${authSkipCount} / 共${total}个, 坏模型缓存: ${broken.size}个`);
}

// ======== 模型列表 ========

/** 从 OpenCode API 获取原始模型列表（不过滤 broken、不排除 embedding/tts） */
export async function fetchRawModels() {
  const auth = getOpenCodeAuth();
  const port = await getOpenCodePort();
  if (!port || !auth) return [];
  try {
    const r = await fetch("http://127.0.0.1:" + port + "/api/model", {
      headers: { Authorization: auth, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return [];
    const models = await r.json();
    if (!Array.isArray(models)) return [];
    return models.map(m => {
      const id = m.providerID + "/" + m.id;
      const isFree = (Array.isArray(m.cost) && m.cost.some(c => c.input === 0 && c.output === 0))
        || m.id.toLowerCase().includes(":free");
      const hasImage = Array.isArray(m.capabilities?.input) && m.capabilities.input.includes("image");
      return { id, name: m.name || m.id, provider: m.providerID, free: isFree, hasImage };
    });
  } catch {
    return [];
  }
}

/** 从 OpenCode API 获取可用模型，动态拉取 + 持久化坏模型缓存 */
export async function fetchAvailableModels() {
  // 复用 fetchRawModels，避免重复 API 请求
  const rawModels = await fetchRawModels();
  const seen = new Map();
  for (const m of rawModels) {
    if (!seen.has(m.id)) seen.set(m.id, m);
  }

  const cfg = getConfig();

  // 确保默认模型在列表中
  const defaultModel = cfg.opencodeModel || "deepseek-v4-pro";

  // 付费模型白名单（从配置读取，可自定义）
  const paidAllowlist = cfg.paidAllowlist;
  const defaultId = defaultModel.includes("/") ? defaultModel : "deepseek/" + defaultModel;
  if (!seen.has(defaultId)) {
    seen.set(defaultId, { id: defaultId, name: defaultModel, provider: defaultModel.includes("/") ? defaultModel.split("/")[0] : "deepseek", free: false });
  }

  // 筛选：免费模型全部保留 + 付费模型只保留主力（从配置读取）
  // paidAllowlist 在函数开头已从 cfg 获取

  // 从持久化文件加载已知坏模型
  const brokenModels = loadBrokenModels();

  // 排除非聊天用途
  const skipKeywords = ["embedding", "tts", "live", "native-audio"];

  const candidates = [...seen.values()].filter(m => {
    if (brokenModels.has(m.id)) return false;
    const nameLower = (m.name || m.id).toLowerCase();
    for (const kw of skipKeywords) { if (nameLower.includes(kw)) return false; }
    // 付费模型只保留主力
    if (!m.free) return paidAllowlist.has(m.id);
    // 免费模型：只保留 opencode (Zen) 和 google (gemma)
    if (m.provider === "opencode" || m.provider === "google") return true;
    return false;
  });

  // 排序：免费优先
  const result = candidates.sort((a, b) => {
    if (a.free && !b.free) return -1;
    if (!a.free && b.free) return 1;
    return a.id.localeCompare(b.id);
  });
  return result;
}
