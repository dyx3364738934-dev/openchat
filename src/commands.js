/**
 * src/commands.js — / 命令系统
 *
 * 职责：
 *   - 解析并执行 / 命令（reset/status/model/agent/help）
 *   - 交互模式状态管理（userPrefs, cmdContext）
 */

import { getConfig } from "../config.js";
import { resetSession, getOpenCodePort, getOpenCodeAuth } from "../opencode-client.js";
import { fetchAvailableModels, probeFreeModels } from "./models.js";
import { VALID_COMMANDS } from "./constants.js";

// ======== 状态（模块级共享） ========

/** 用户偏好（内存存储）：userId → { model?, agent? } */
export const userPrefs = new Map();

/** 命令上下文（交互式命令用）：userId → { cmd, data } */
export const cmdContext = new Map();

// ======== 命令处理 ========

export async function handleSlashCommand(raw, userId, { token, baseUrl, contextToken }) {
  const parts = raw.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  // 如果用户在交互模式中
  const ctx = cmdContext.get(userId);
  if (ctx && ctx.cmd === "model") {
    // 如果输入的是其他有效 / 命令（如 /help /reset），先退出交互模式再执行
    if (cmd !== "model" && VALID_COMMANDS.has(cmd)) {
      cmdContext.delete(userId);
      // 继续往下执行该命令
    } else if (cmd === "model" && !args[0]) {
      // 再次输入 /model（无参数）→ 重新列出模型列表
      cmdContext.delete(userId);
      // 继续往下执行 /model 命令
    } else {
      // /model 2  → 解析为选择序号 2
      const choice = (cmd === "model" && args[0]) ? args[0] : cmd;
      // 严格数字判断：排除空字符串和纯空格
      if (choice !== "" && !isNaN(Number(choice))) {
        const idx = parseInt(choice) - 1;
        if (idx >= 0 && idx < ctx.data.length) {
          const chosen = ctx.data[idx];
          userPrefs.set(userId, { ...userPrefs.get(userId), model: chosen.id });
          cmdContext.delete(userId);
          return `模型已切换为 ${chosen.id}\n(${chosen.name || chosen.id})`;
        }
        return `序号超出范围 (1-${ctx.data.length})，请重新输入`;
      }
      // 非数字 → 名称匹配
      const match = ctx.data.find(m => m.id === choice || m.name === choice || m.id.endsWith("/" + choice));
      if (match) {
        userPrefs.set(userId, { ...userPrefs.get(userId), model: match.id });
        cmdContext.delete(userId);
        return `模型已切换为 ${match.id}`;
      }
      return `未找到 "${choice}"，请重试 (/model 重新列表，或输入其他命令如 /help)`;
    }
  }

  // 清除之前的交互上下文
  cmdContext.delete(userId);

  switch (cmd) {
    case "reset":
      resetSession(userId);
      return "会话已重置";

    case "status": {
      const pref = userPrefs.get(userId) || {};
      const model = pref.model || getConfig().opencodeModel || "deepseek-v4-pro";
      const agent = pref.agent || getConfig().opencodeAgent || "build";
      return `当前状态\n模型: ${model}\nAgent: ${agent}\n发送 /help 查看命令`;
    }

    case "model": {
      // /model refresh — 重新探测免费模型可用性
      if (args[0]?.toLowerCase() === "refresh") {
        cmdContext.delete(userId);
        try {
          if (!(await getOpenCodePort())) return "无法检测 OpenCode 端口，请确保桌面应用正在运行";
          await probeFreeModels();
          const models = await fetchAvailableModels();
          const freeCount = models.filter(m => m.free).length;
          return `刷新完成 ✅\n当前可用: ${models.length} 个模型 (其中 ${freeCount} 个免费)\n发送 /model 查看列表`;
        } catch (err) {
          return `刷新失败: ${err.message}`;
        }
      }
      // 无参数：列出可用模型，按供应商分组
      if (!args[0]) {
        const models = await fetchAvailableModels();
        if (models.length === 0) return "无法获取可用模型列表";
        const providerLabels = getConfig().providerLabels;
        const groups = new Map();
        for (const m of models) {
          const provider = m.provider || "other";
          if (!groups.has(provider)) groups.set(provider, []);
          groups.get(provider).push(m);
        }
        // 按显示顺序构建扁平列表，存入 cmdContext 供选择时用
        const displayOrder = [];
        const lines = [];
        let idx = 1;
        for (const [provider, groupModels] of groups) {
          const label = providerLabels[provider] || provider;
          lines.push(`${label}:`);
          for (const m of groupModels) {
            const shortName = m.id.includes("/") ? m.id.split("/").pop() : m.id;
            const freeTag = m.free ? " 🆓" : "";
            lines.push(`  ${idx}. ${shortName}${freeTag}`);
            displayOrder.push(m);
            idx++;
          }
        }
        cmdContext.set(userId, { cmd: "model", data: displayOrder });
        return `可用模型：\n${lines.join("\n")}\n\n回复序号或全名切换`;
      }
      // 有参数：优先用缓存的模型列表（序号与显示一致），无缓存时只接受名称匹配
      const choice = args[0];
      // 先查缓存列表
      const cachedModels = cmdContext.get(userId)?.cmd === "model" ? cmdContext.get(userId).data : null;
      if (cachedModels && !isNaN(Number(choice))) {
        const idx = parseInt(choice) - 1;
        if (idx >= 0 && idx < cachedModels.length) {
          const chosen = cachedModels[idx];
          if (!userPrefs.has(userId)) userPrefs.set(userId, {});
          userPrefs.get(userId).model = chosen.id;
          cmdContext.delete(userId);
          return `模型已切换为 ${chosen.id}\n(${chosen.name || chosen.id})`;
        }
        return `序号超出范围 (1-${cachedModels.length})，/model 重新列表`;
      }
      // 无缓存时按名称匹配（不接受序号，因为序号与显示不一致）
      const models = await fetchAvailableModels();
      const match = models.find(m => m.id === choice || m.name === choice || m.id.endsWith("/" + choice));
      if (match) {
        if (!userPrefs.has(userId)) userPrefs.set(userId, {});
        userPrefs.get(userId).model = match.id;
        cmdContext.delete(userId);
        return `模型已切换为 ${match.id}`;
      }
      return `未找到 "${choice}"，先 /model 看列表，再选序号或输入全名`;
    }

    case "agent": {
      if (!args[0]) return "用法: /agent <agent类型>\n例如: /agent build";
      if (!userPrefs.has(userId)) userPrefs.set(userId, {});
      userPrefs.get(userId).agent = args[0];
      return `Agent 已切换为 ${args[0]}`;
    }

    case "help":
      return [
        "可用命令：",
        "/reset  - 重置会话",
        "/status - 查看当前状态",
        "/model  - 列出并切换模型",
        "/model <名> - 直接切换模型",
        "/model refresh - 重新检测免费模型可用性",
        "/agent <类型> - 切换 agent",
        "/help - 显示此帮助",
      ].join("\n");

    default:
      return `未知命令: /${cmd}\n发送 /help 查看可用命令`;
  }
}
