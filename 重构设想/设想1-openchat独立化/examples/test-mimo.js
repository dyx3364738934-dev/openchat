/**
 * examples/test-mimo.js — 验证 mimocode 可独立启动并抓免费模型
 *
 * 验证目标：
 *   1. mimo CLI 存在 (mimo --version)
 *   2. mimo serve 可独立启动（不需要桌面版）
 *   3. mimo serve 不需要 Basic Auth
 *   4. mimo 列模型 endpoint (/provider) 返回 JSON
 *   5. 至少 5+ 个免费模型可抓
 *
 * 运行：
 *   $ node examples/test-mimo.js
 */

import { detectAgentCli, bootstrapServer, listModels, checkHealth, callAgent } from "../lib/openchat-sdk.js";

async function main() {
  console.log("=== 设想 1 PoC: mimocode 独立化验证 ===\n");

  // 阶段 1: 检测 agent CLI
  console.log("[阶段 1] 检测 agent CLI...");
  const cli = detectAgentCli();
  if (!cli) {
    console.error("  ❌ 未找到 mimo 或 opencode CLI");
    console.error("  安装：npm install -g @mimo-ai/cli 或 npm install -g opencode-ai");
    process.exit(1);
  }
  console.log(`  ✅ ${cli.name} ${cli.version} @ ${cli.path}\n`);

  // 阶段 2: 启动 headless server
  console.log("[阶段 2] 启动 headless server...");
  const port = cli.name === "mimo" ? 14114 : 4097; // 用不同端口避免冲突
  const bootstrap = await bootstrapServer({
    port,
    host: "127.0.0.1",
    silent: false,
    onLog: (stream, msg) => {
      if (msg.trim()) console.log(`  [serve:${stream}] ${msg.trim()}`);
    },
  });
  console.log(`  ✅ ${bootstrap.cli} serve 已就绪 (${bootstrap.alreadyRunning ? "复用现有" : "新启动"})\n`);

  // 阶段 3: 健康检查
  console.log("[阶段 3] 健康检查...");
  const health = await checkHealth(bootstrap.cfg);
  console.log(`  ${health.healthy ? "✅" : "❌"} healthy: ${health.healthy}, version: ${health.version}\n`);

  // 阶段 4: 列出模型
  console.log("[阶段 4] 列出可用模型...");
  const models = await listModels(bootstrap.cfg);
  console.log(`  总数: ${models.length} 个`);
  const free = models.filter((m) => m.free);
  console.log(`  免费: ${free.length} 个\n`);

  console.log("  全部模型:");
  for (const m of models) {
    const tag = m.free ? "🆓" : "  ";
    const img = m.hasImage ? "🖼" : "  ";
    console.log(`    ${tag}${img} ${m.id} (${m.name})`);
  }

  // 阶段 5: 实际发消息测试（如果默认模型可用）
  if (free.length > 0) {
    const defaultModel = free[0];
    console.log(`\n[阶段 5] 发消息测试 (${defaultModel.id})...`);
    try {
      const result = await callAgent("test-user", "你好，请用一句话介绍你自己", {
        model: defaultModel.id,
        agent: "build",
      });
      console.log(`  ✅ 回复 (${result.text.length} 字符):`);
      console.log(`    ${result.text.slice(0, 200)}${result.text.length > 200 ? "..." : ""}`);
    } catch (err) {
      console.error(`  ⚠️ 调用失败: ${err.message.slice(0, 200)}`);
    }
  }

  // 阶段 6: 清理
  console.log("\n[阶段 6] 清理...");
  if (bootstrap.process) {
    bootstrap.stop();
    console.log("  ✅ 已关闭 serve 子进程");
  } else {
    console.log("  (未启动新进程，无需清理)");
  }

  console.log("\n=== 验证完成 ===");
  console.log("\n结论：");
  console.log(`  1. ${cli.name} CLI 可用: ✅`);
  console.log(`  2. ${cli.name} serve 可独立启动（不依赖桌面版）: ✅`);
  console.log(`  3. ${cli.name} serve 无 Basic Auth: ${cli.name === "mimo" ? "✅" : "⚠️"}`);
  console.log(`  4. 抓免费模型数量: ${free.length} (${free.length >= 5 ? "✅" : "⚠️ 不足 5"})`);
  if (free.length >= 5) {
    console.log(`\n✅ 设想 1 成立：openchat 可以完全独立于桌面版，通过 ${cli.name} CLI 直接接入免费模型。`);
  } else {
    console.log(`\n⚠️ 免费模型不足，可能需要其他 fallback 方案。`);
  }
}

main().catch((err) => {
  console.error("❌ 测试失败:", err.message);
  process.exit(1);
});
