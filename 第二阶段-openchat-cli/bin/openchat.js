#!/usr/bin/env node
/**
 * bin/openchat.js — openchat CLI 主程序
 *
 * 启动流程：
 *   1. 显示启动 banner
 *   2. 检测 mimo/opencode CLI + 启动 headless server
 *   3. 列出免费模型 + 激活默认模型
 *   4. 激活微信插件 + QR 扫码登录（5 分钟超时）
 *   5. 根据登录结果：
 *      - ok → 微信映射模式（微信消息 + REPL 都可用）
 *      - skipped/timeout → REPL 模式（命令行 agent 交互）
 *
 * 用法：
 *   $ openchat                       # 完整流程
 *   $ openchat --port 14115          # 指定 server 端口
 *   $ openchat --no-wechat           # 跳过微信登录，直接 REPL
 *   $ openchat --model huoshan/glm-5.1  # 指定默认模型
 *   $ openchat --help                # 帮助
 */

import { bootstrapBackend } from "../src/bootstrap.js";
import { wechatLoginWithSkip, WeChatGateway } from "../src/wechat-gateway.js";
import { startREPL } from "../src/repl.js";

// ============================================================
// CLI 参数
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    port: args.includes("--port") ? parseInt(args[args.indexOf("--port") + 1]) : null,
    noWechat: args.includes("--no-wechat"),
    model: args.includes("--model") ? args[args.indexOf("--model") + 1] : null,
    help: args.includes("--help") || args.includes("-h"),
  };
}

function printHelp() {
  console.log(`
openchat — 命令行 AI 交互工具 (基于 mimo/opencode)

用法:
  openchat [选项]

选项:
  --port <number>          指定 agent server 端口
                           (默认: mimo=14113, opencode=4096)
  --no-wechat              跳过微信登录，直接进入 REPL 模式
  --model <provider/id>    指定默认模型（如 huoshan/glm-5.1）
  --help, -h               显示帮助

示例:
  $ openchat                          # 完整流程
  $ openchat --no-wechat              # 纯命令行 agent
  $ openchat --model mimo/mimo-auto   # 指定 mimo-auto（支持图片）
  $ openchat --port 14115             # 用 14115 端口

交互命令（REPL 内）:
  /model [名|序号]    切换模型
  /status             查看当前状态
  /reset              重置会话
  /help               帮助
  /exit               退出
`);
}

// ============================================================
// 启动 banner
// ============================================================

function printBanner() {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║           openchat — 命令行 AI 交互工具 v2.0              ║
║                                                           ║
║   基于 mimocode/opencode CLI + 微信桥                     ║
║   免费模型 + 微信控制 + 命令行 REPL 三合一                ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);
}

// ============================================================
// 激活显示
// ============================================================

function printActivation({ cli, cfg, models, defaultModel }) {
  console.log("🔧 [阶段 1/3] 激活后端服务");
  console.log(`   ✓ CLI: ${cli.name} ${cli.version}`);
  console.log(`   ✓ Server: http://${cfg.host}:${cfg.port}`);
  console.log(`   ✓ 路径: ${cli.path}`);

  console.log("\n🎁 [阶段 2/3] 激活免费模型服务配置");
  const free = models.filter((m) => m.free);
  console.log(`   ✓ 可用模型: ${models.length} 个`);
  console.log(`   ✓ 免费模型: ${free.length} 个`);
  if (free.length > 0) {
    console.log("   ✓ 免费模型列表:");
    free.forEach((m) => {
      const tag = m.hasImage ? "🖼" : "  ";
      console.log(`     ${tag} ${m.id.padEnd(35)} (${m.name})`);
    });
  }
  console.log(`   ✓ 默认模型: ${defaultModel.id} ${defaultModel.hasImage ? "(支持图片)" : ""}`);
}

function printWechatPlugin() {
  console.log("\n📱 [阶段 3/3] 激活微信插件");
  console.log("   ✓ 微信 API: ilinkai.weixin.qq.com");
  console.log("   ✓ QR 扫码登录（5 分钟时效）");
  console.log("   ✓ 跳过登录: 输入 'skip' 或 's'");
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }

  printBanner();

  // 1. 启动后端服务 + 激活免费模型
  let backend;
  try {
    backend = await bootstrapBackend({ port: args.port, silent: true });
  } catch (err) {
    console.error(`\n❌ 后端启动失败: ${err.message}`);
    process.exit(1);
  }

  printActivation(backend);

  // 如果指定了 --model，切换默认
  let defaultModel = backend.defaultModel;
  if (args.model) {
    const target = backend.models.find((m) => m.id === args.model || m.id.endsWith("/" + args.model));
    if (target) {
      defaultModel = target;
      console.log(`   ✓ 用户指定模型: ${target.id}`);
    } else {
      console.warn(`   ⚠️ 指定模型 ${args.model} 未找到，使用默认`);
    }
  }

  // 2. 激活微信插件 + 扫码登录
  let wechat = null;
  let wechatLoginResult = null;

  if (args.noWechat) {
    console.log("\n📱 [微信] 跳过（--no-wechat）");
  } else {
    printWechatPlugin();
    console.log("\n⏳ 启动 QR 扫码登录...");
    try {
      wechatLoginResult = await wechatLoginWithSkip();
    } catch (err) {
      console.error(`\n❌ 微信登录异常: ${err.message}`);
      wechatLoginResult = { status: "error" };
    }

    switch (wechatLoginResult.status) {
      case "ok":
        console.log(`\n✅ 微信登录成功！Bot ID: ${wechatLoginResult.accountId || "?"}`);
        wechat = new WeChatGateway({
          token: wechatLoginResult.token,
        });
        break;
      case "skipped":
        console.log("\n⏭️ 用户跳过微信登录");
        break;
      case "timeout":
        console.log("\n⏰ 5 分钟超时未扫码");
        break;
      default:
        console.log(`\n⚠️ 微信登录状态: ${wechatLoginResult.status}`);
    }
  }

  // 3. 进入交互模式
  console.log("\n" + "━".repeat(60));
  if (wechat) {
    console.log("🟢 进入微信映射模式（微信消息 → agent → 发回微信）");
    console.log("   命令行 REPL 也可用（直接输入即可）");
  } else {
    console.log("🟢 进入 REPL 模式（命令行直接对话 agent）");
  }
  console.log("━".repeat(60));

  // 如果微信登录成功，启动微信网关后台
  let wechatReady = false;
  if (wechat) {
    wechat.onMessage(async (msg) => {
      if (!msg.text) return;
      try {
        // 显示在 REPL 里
        console.log(`\n📩 [微信] ${msg.from}: ${msg.text.slice(0, 80)}`);
        const { callAgent } = await import("../src/openchat-sdk.js");
        const result = await callAgent(msg.from, msg.text, { model: defaultModel.id });
        const { StreamingMarkdownFilter } = await import("../src/markdown-filter.js");
        const mf = new StreamingMarkdownFilter();
        const filtered = mf.feed(result.text) + mf.flush();
        console.log(`💬 [回复] ${filtered.slice(0, 200)}${filtered.length > 200 ? "..." : ""}`);
        await wechat.send({ toUserId: msg.from, text: filtered, contextToken: msg.contextToken });
      } catch (err) {
        console.error(`❌ 微信消息处理失败: ${err.message}`);
      }
    });

    // 后台启动微信网关（不阻塞 REPL）
    wechat.start().catch((err) => {
      console.error(`❌ 微信网关异常: ${err.message}`);
    });
    wechatReady = true;
  }

  // 启动 REPL（阻塞）
  await startREPL({
    cfg: backend.cfg,
    defaultModel,
    models: backend.models,
  });

  // REPL 退出后清理
  if (wechat) await wechat.stop();
  backend.stop();
}

// ============================================================
// 启动
// ============================================================

main().catch((err) => {
  console.error("\n💥 致命错误:", err.message);
  console.error(err.stack);
  process.exit(1);
});
