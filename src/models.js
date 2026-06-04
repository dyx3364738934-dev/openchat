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

// ======== 硬编码模型常量 ========

/** 免费但名称不以 -free 结尾的模型（手动维护） */
const FREE_MODEL_IDS = new Set(["big-pickle"]);

/** 已知不可用的模型 ID（API 端点已关闭/损坏，提前排除，不浪费探头） */
const KNOWN_UNAVAILABLE_MODEL_IDS = new Set([
  "ring-2.6-1t",
  "ring-2.6-1t-free",
  "trinity-large-preview-free",
]);

/** 容量受限模型备注（/model 列表时展示） */
const CAPACITY_LIMITED_NOTES = {
  "qwen3.6-plus-free":
    "容量受限——短 prompt 稳定，高并发或大工具目录可能 5xx，建议回退到 deepseek-v4-flash-free / big-pickle",
};

// ======== models.dev 元数据缓存 ========

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const MODELS_DEV_TTL_MS = 3600_000; // 1 小时缓存

let _modelsDevSnapshot = null;
let _modelsDevFetchedAt = 0;

/** 从 models.dev 获取模型元数据快照（含弃用状态），按小时缓存 */
async function fetchModelsDevSnapshot() {
  const now = Date.now();
  if (_modelsDevSnapshot && (now - _modelsDevFetchedAt) < MODELS_DEV_TTL_MS) {
    return _modelsDevSnapshot;
  }
  try {
    const res = await fetch(MODELS_DEV_API_URL, {
      headers: { "User-Agent": "openchat/1.4" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn("models", `models.dev 返回 HTTP ${res.status}，使用缓存`);
      return _modelsDevSnapshot || null;
    }
    _modelsDevSnapshot = await res.json();
    _modelsDevFetchedAt = now;
    logger.debug("models", "models.dev 元数据已更新");
    return _modelsDevSnapshot;
  } catch (err) {
    logger.warn("models", "models.dev 元数据获取失败（非关键）", err.message);
    return _modelsDevSnapshot || null;
  }
}

/**
 * 检查模型是否被 models.dev 标记为 deprecated
 * @param {string} shortId - 短模型 ID（如 "qwen3.6-plus-free"）
 * @param {string} provider - 供应商 ID（如 "opencode"）
 */
function isModelDeprecated(snapshot, shortId, provider) {
  if (!snapshot?.providers?.[provider]) return false;
  return snapshot.providers[provider][shortId]?.status === "deprecated";
}

// ======== Zen 云 API 模型列表 ========

const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const ZEN_CACHE_TTL_MS = 600_000; // 10 分钟缓存（比 models.dev 短，模型上下线更频繁）

let _zenModelIds = null;
let _zenFetchedAt = 0;

/**
 * 从 Zen 云 API 获取当前在线的模型 ID 集合
 * 云 API 只返回实际可用的模型，已下线/弃用的模型不会出现在列表中
 * 这就是 VSCode 插件免费模型只有 3-4 个的根因
 */
async function fetchZenModelIds() {
  const now = Date.now();
  if (_zenModelIds && (now - _zenFetchedAt) < ZEN_CACHE_TTL_MS) {
    return _zenModelIds;
  }
  try {
    const res = await fetch(ZEN_MODELS_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn("models", `Zen 云 API 返回 HTTP ${res.status}，使用缓存`);
      return _zenModelIds || null;
    }
    const data = await res.json();
    if (!data?.data || !Array.isArray(data.data)) return _zenModelIds || null;
    _zenModelIds = new Set(data.data.filter(m => m.id).map(m => m.id));
    _zenFetchedAt = now;
    logger.info("models", `Zen 云 API: ${_zenModelIds.size} 个在线模型`);
    return _zenModelIds;
  } catch (err) {
    logger.warn("models", "Zen 云 API 不可达（非关键）", err.message);
    return _zenModelIds || null;
  }
}

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
      const shortId = m.id; // API 返回的短 ID，如 "qwen3.6-plus-free"
      const provider = m.providerID;

      // 按供应商分支免费判定：
      // - opencode (Zen): -free 后缀是权威免费标识，不依赖 cost 数据
      //   因为 cost 数据可能包含试用条目 {input:0,output:0}，导致误判
      // - 其他供应商: cost 数据 + :free / -free 命名惯例
      const isFree = provider === "opencode"
        ? (shortId.toLowerCase().endsWith("-free") || FREE_MODEL_IDS.has(shortId))
        : ((Array.isArray(m.cost) && m.cost.some(c => c.input === 0 && c.output === 0))
            || shortId.toLowerCase().includes(":free")
            || shortId.toLowerCase().endsWith("-free"));
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

  // 解析默认模型 ID，避免硬编码 provider
  let defaultId, defaultProvider;
  if (defaultModel.includes("/")) {
    defaultId = defaultModel;
    defaultProvider = defaultModel.split("/")[0];
  } else {
    // 短名称：从 paidAllowlist 或 seen 中查找完整 ID
    defaultId = [...paidAllowlist].find(id => id.endsWith("/" + defaultModel))
      || [...seen.keys()].find(id => id.endsWith("/" + defaultModel))
      || "deepseek/" + defaultModel; // 兜底
    defaultProvider = defaultId.includes("/") ? defaultId.split("/")[0] : "deepseek";
  }
  if (!seen.has(defaultId)) {
    seen.set(defaultId, { id: defaultId, name: defaultModel, provider: defaultProvider, free: false });
  }

  // 从持久化文件加载已知坏模型
  const brokenModels = loadBrokenModels();

  // 获取 models.dev 元数据快照（非关键，失败不影响）
  const modelsDevSnapshot = await fetchModelsDevSnapshot();

  // 排除非聊天用途
  const skipKeywords = ["embedding", "tts", "live", "native-audio"];

  let candidates = [...seen.values()].filter(m => {
    // 解析短 ID 用于 models.dev / 黑名单匹配
    const shortId = m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id;

    if (brokenModels.has(m.id)) return false;
    if (KNOWN_UNAVAILABLE_MODEL_IDS.has(shortId)) {
      logger.debug("models", "跳过已知不可用模型", { model: m.id });
      return false;
    }
    if (isModelDeprecated(modelsDevSnapshot, shortId, m.provider)) {
      logger.info("models", "跳过已弃用模型 (models.dev)", { model: m.id });
      return false;
    }
    const nameLower = (m.name || m.id).toLowerCase();
    for (const kw of skipKeywords) { if (nameLower.includes(kw)) return false; }

    // 谷歌 gemma 系列硬编码排除（需独立 API key + 代理，日常用不上）
    if (m.provider === "google" && shortId.toLowerCase().startsWith("gemma")) return false;

    // 其余模型全展示——用户配置了就是有用的，不替用户做选择
    return true;
  });

  // Zen 模型：用云 API 做最终过滤（云 API 只返回实际在线的模型，已下线的不会出现）
  const zenCloudIds = await fetchZenModelIds();
  if (zenCloudIds) {
    const before = candidates.filter(m => m.provider === "opencode").length;
    candidates = candidates.filter(m => {
      if (m.provider !== "opencode") return true;
      const shortId = m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id;
      return zenCloudIds.has(shortId);
    });
    const after = candidates.filter(m => m.provider === "opencode").length;
    const removed = before - after;
    if (removed > 0) {
      logger.info("models", `Zen 云 API 过滤: ${removed} 个已下线模型已排除`);
    }
  }

  // Zen (opencode) 套餐只保留免费模型——付费模型走 Zen 云 API 不是 openchat 的目标场景
  {
    const before = candidates.length;
    candidates = candidates.filter(m => m.provider !== "opencode" || m.free);
    const removed = before - candidates.length;
    if (removed > 0) {
      logger.info("models", `Zen 付费模型过滤: ${removed} 个已排除`);
    }
  }

  // 排序：免费优先
  const result = candidates.sort((a, b) => {
    if (a.free && !b.free) return -1;
    if (!a.free && b.free) return 1;
    return a.id.localeCompare(b.id);
  });
  return result;
}
