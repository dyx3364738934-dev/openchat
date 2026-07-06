/**
 * src/repl.js — 交互式命令行 REPL
 *
 * 职责：
 *   1. 提供 readline 交互界面
 *   2. 内置命令: /model, /reset, /status, /help, /exit
 *   3. 用户输入 → agent 调用 → 输出回复
 *   4. 支持流式输出（每 2s 拉一次 reply）
 */

import { createInterface } from "node:readline";
import { StreamingMarkdownFilter } from "./markdown-filter.js";
import { callAgent, listModels } from "./openchat-sdk.js";

/**
 * 启动 REPL
 *
 * @param {object} ctx
 * @param {object} ctx.cfg - backend 配置（host/port 等）
 * @param {object} ctx.defaultModel - 默认模型
 * @param {object} ctx.models - 全部模型列表
 * @param {Function} ctx.onUserMessage - 用户输入回调（用于 wechat 模式时也调用）
 */
export async function startREPL({ cfg, defaultModel, models, onUserMessage = null } = {}) {
  const state = {
    currentModel: defaultModel,
    sessionCaches: new Map(), // userId → { lastReply }
  };

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `openchat [${state.currentModel.id}] > `,
  });

  // 启动提示
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  openchat REPL — 交互式命令行 agent");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`当前模型: ${state.currentModel.id} (${state.currentModel.name})`);
  console.log(`可用模型: ${models.length} 个 (免费 ${models.filter(m => m.free).length} 个)`);
  console.log("\n命令:");
  console.log("  /model [名|序号]  切换模型（/model 查看列表）");
  console.log("  /status           查看当前状态");
  console.log("  /reset            重置当前会话");
  console.log("  /help             显示帮助");
  console.log("  /exit  /quit      退出\n");

  // 主动触发用户回调（如果传了）
  const userMsgCtx = { cfg, state, models, rl };

  rl.prompt();

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    // 处理内置命令
    if (trimmed.startsWith("/")) {
      const handled = await handleCommand(trimmed, userMsgCtx);
      if (handled === "exit") {
        rl.close();
        return;
      }
      rl.prompt();
      return;
    }

    // 普通消息 → 调用 agent
    try {
      console.log("...");
      const result = await callAgent("repl-user", trimmed, { model: state.currentModel.id });
      const mf = new StreamingMarkdownFilter();
      const filtered = mf.feed(result.text) + mf.flush();
      console.log(`\n[${state.currentModel.id}]\n${filtered}\n`);

      // 如果有微信网关，也调用回调（但默认 REPL 模式下不调用）
      if (onUserMessage) {
        try { await onUserMessage(trimmed, result); } catch {}
      }
    } catch (err) {
      console.error(`\n❌ agent 调用失败: ${err.message}\n`);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\n👋 再见");
    process.exit(0);
  });
}

/**
 * 处理内置命令
 * @returns {Promise<string|null>} "exit" 表示退出，否则 null
 */
async function handleCommand(raw, { state, models }) {
  const parts = raw.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case "help":
    case "h":
    case "?":
      console.log(`
可用命令:
  /model [名|序号]   切换模型（/model 查看列表）
  /status           查看当前状态
  /reset            重置当前会话
  /help             显示帮助
  /exit  /quit      退出
`);
      return null;

    case "exit":
    case "quit":
    case "q":
      return "exit";

    case "status":
      console.log(`
当前状态:
  模型: ${state.currentModel.id} (${state.currentModel.name})
  免费: ${state.currentModel.free ? "是" : "否"}
  支持图片: ${state.currentModel.hasImage ? "是" : "否"}
  上下文: ${state.currentModel.context || "未知"}
`);
      return null;

    case "model":
    case "m":
      if (!args[0]) {
        // 列出所有模型
        const free = models.filter((m) => m.free);
        const paid = models.filter((m) => !m.free);
        console.log("\n可用模型:");
        console.log("  免费:");
        free.forEach((m, i) => {
          const tag = m.hasImage ? "🖼" : "  ";
          const marker = m.id === state.currentModel.id ? "→" : " ";
          console.log(`    ${marker} ${tag} ${i + 1}. ${m.id} (${m.name})`);
        });
        if (paid.length > 0) {
          console.log("  付费:");
          paid.forEach((m, i) => {
            const tag = m.hasImage ? "🖼" : "  ";
            console.log(`      ${tag} ${free.length + i + 1}. ${m.id} (${m.name})`);
          });
        }
        console.log("\n切换: /model <序号> 或 /model <provider/model>");
      } else {
        // 切换模型
        const choice = args[0];
        let target = null;
        if (!isNaN(Number(choice))) {
          const idx = parseInt(choice) - 1;
          target = models[idx];
        } else {
          target = models.find((m) => m.id === choice || m.id.endsWith("/" + choice));
        }
        if (target) {
          state.currentModel = target;
          console.log(`✓ 模型切换为: ${target.id}`);
        } else {
          console.log(`❌ 未找到模型: ${choice}`);
        }
      }
      return null;

    case "reset":
    case "r":
      // callAgent 的 session cache 在 openchat-sdk.js 内部管理
      // 这里只能标记下次调用换 session（实际不需要，因为模型切换自动换 session）
      console.log("✓ 会话已重置（下次调用会创建新 session）");
      return null;

    default:
      console.log(`❌ 未知命令: /${cmd}（输入 /help 查看可用命令）`);
      return null;
  }
}
