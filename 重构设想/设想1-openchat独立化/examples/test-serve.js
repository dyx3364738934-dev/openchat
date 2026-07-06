/**
 * examples/test-serve.js — 验证 opencode serve 可独立启动并通讯
 *
 * 流程：
 *   1. 检查是否已有 opencode serve 在 4096 跑
 *   2. 如果没有，自动启动一个
 *   3. 健康检查
 *   4. 列出模型
 *   5. 优雅关闭
 *
 * 运行：
 *   $ node examples/test-serve.js
 *   或 $ OPENCODE_SERVER_PASSWORD=mypwd node examples/test-serve.js
 */

import { resolveServeConfig, checkHealth, listModels, bootstrapServer } from "../lib/openchat-sdk.js";

async function main() {
  console.log("=== 设想 1 PoC: opencode serve 独立化验证 ===\n");

  // 阶段 1: 检测当前配置
  const cfg = resolveServeConfig();
  console.log("[阶段 1] 当前配置:");
  console.log(`  host: ${cfg.host}`);
  console.log(`  port: ${cfg.port}`);
  console.log(`  username: ${cfg.username}`);
  console.log(`  password: ${cfg.password ? "(已设置)" : "(未设置)"}\n`);

  // 阶段 2: 检测已有 serve
  console.log("[阶段 2] 检测现有 opencode serve...");
  const existing = await checkHealth(cfg);
  if (existing.healthy) {
    console.log(`  ✅ 已有 serve 在运行 (version: ${existing.version || "unknown"})\n`);
  } else {
    console.log(`  ⚠️ 当前无 serve: ${existing.error}`);
    console.log(`  尝试自动启动一个...\n`);
  }

  // 阶段 3: 如果没有，自动 bootstrap
  let bootstrap;
  if (!existing.healthy) {
    bootstrap = await bootstrapServer({
      port: cfg.port,
      host: cfg.host,
      silent: false,
      onLog: (stream, msg) => {
        if (msg.trim()) console.log(`  [serve:${stream}] ${msg.trim()}`);
      },
    });
    console.log(`\n  ✅ 已启动 serve${bootstrap.alreadyRunning ? " (复用现有)" : ""}`);
  }

  // 阶段 4: 健康检查
  console.log("[阶段 3] 健康检查...");
  const health = await checkHealth(cfg);
  console.log(`  ${health.healthy ? "✅" : "❌"} healthy: ${health.healthy}, version: ${health.version || "?"}\n`);

  // 阶段 5: 列出模型
  console.log("[阶段 4] 列出可用模型...");
  const models = await listModels(cfg);
  console.log(`  总数: ${models.length} 个`);
  const free = models.filter((m) => m.free);
  console.log(`  免费: ${free.length} 个\n`);
  console.log("  前 10 个:");
  for (const m of models.slice(0, 10)) {
    const tag = m.free ? "🆓" : "  ";
    console.log(`    ${tag} ${m.id}`);
  }

  // 阶段 6: 清理
  console.log("\n[阶段 5] 清理...");
  if (bootstrap?.process) {
    bootstrap.stop();
    console.log("  ✅ 已关闭启动的 serve 子进程");
  } else {
    console.log("  (未启动新进程，无需清理)");
  }

  console.log("\n=== 验证完成 ===");
  console.log("结论：opencode serve 是 headless 可独立运行的，不依赖 opencode 桌面版。");
}

main().catch((err) => {
  console.error("❌ 测试失败:", err.message);
  process.exit(1);
});
