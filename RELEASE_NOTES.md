# OpenChat v2.0.1 发行说明

OpenChat 是微信 ↔ OpenCode Agent 桥。这个版本面向普通安装与使用，不包含实验性 PoC 文档或本地重构草稿。

## 安装

### Git 安装

```bash
git clone https://github.com/dyx3364738934-dev/openchat.git
cd openchat
npm install
copy config.example.json config.json
node bridge.js
```

### npm 全局安装

```bash
npm install -g https://github.com/dyx3364738934-dev/openchat.git
openchat
```

## 运行条件

- Windows 10 / 11
- Node.js 18+
- OpenCode 桌面版正在运行
- 推荐在 OpenCode 内置终端启动，以便读取 `OPENCODE_SERVER_PASSWORD`

## 本版内容

- 修正 v2.0.0 发行树，把内部 PoC / 重构草稿移出当前发行分支
- 发布包名统一为 `openchat`
- 提供 `openchat` 全局命令入口
- README 补齐 Git / ZIP / npm 全局安装方式
- 修复 Windows 启动器硬编码旧路径的问题
- 发行包只包含运行所需文件，不包含本地运行状态、日志、依赖目录或敏感配置

## 安全说明

- `config.json` 不会提交到仓库，也不会进入发行包
- `node_modules/`、`logs/`、`state/` 不会进入发行包
- 微信 token、OpenCode password 等敏感信息仅从本地配置或环境变量读取
