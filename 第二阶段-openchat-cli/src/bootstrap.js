/**
 * src/bootstrap.js — 启动模块
 *
 * 职责：
 *   1. 检测 mimo/opencode CLI
 *   2. 自动启动 headless server
 *   3. 列出可用模型（重点免费模型）
 *   4. 选定默认模型
 */

import { spawn } from "node:child_process";
import {
  detectAgentCli,
  bootstrapServer,
  resolveServeConfig,
  listModels,
} from "./openchat-sdk.js";

/**
 * 启动 openchat 后端服务
 * @returns {Promise<{cfg, cli, process, stop, models, defaultModel}>}
 */
export async function bootstrapBackend({ port = null, silent = false, onLog = null } = {}) {
  // 阶段 1: 检测 CLI
  const cli = detectAgentCli();
  if (!cli) {
    throw new Error(
      "未找到 mimo 或 opencode CLI\n" +
      "请先安装:\n" +
      "  npm install -g @mimo-ai/cli    (推荐 — 无鉴权 bug)\n" +
      "  npm install -g opencode-ai"
    );
  }

  // 阶段 2: 启动 server
  const boot = await bootstrapServer({
    port,
    host: "127.0.0.1",
    silent,
    onLog,
  });

  // 阶段 3: 列模型
  const models = await listModels(boot.cfg);
  const free = models.filter((m) => m.free);

  // 阶段 4: 默认模型（优先选支持图片的免费模型）
  let defaultModel = free.find((m) => m.hasImage) || free[0] || null;
  if (!defaultModel) {
    throw new Error("没有可用模型（连付费模型都没，请检查网络）");
  }

  return {
    cli,
    cfg: boot.cfg,
    process: boot.process,
    stop: boot.stop,
    alreadyRunning: boot.alreadyRunning,
    models,
    free,
    defaultModel,
  };
}
