# OpenChat

WeChat + OpenCode Agent Bridge — control your PC agent via WeChat messages.

## Quick Start

```
1. Double-click setup.bat (one-time)
2. Restart terminal
3. openchat
```

On first run, scan the QR code (PNG popup) with WeChat to login.
Subsequent runs use the saved token automatically.

## Requirements

| Item | Detail |
|------|--------|
| OS | Windows 10/11 |
| Node.js | v18+ |
| OpenCode | Desktop app running |
| Terminal | OpenCode built-in terminal (Ctrl+`) recommended |

## Architecture

```
WeChat App
    |  (user sends message)
    v
WeChat Server (ilinkai.weixin.qq.com)
    |  (long-poll HTTP JSON)
    v
openchat (bridge.js)  <-- this project
    |  (HTTP API, auto-detect port)
    v
OpenCode Desktop (127.0.0.1:random)
    |  (agent: LLM + tools)
    v
WeChat User (receives reply)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WECHAT_TOKEN` | auto-saved | WeChat bot token (from QR login) |
| `WECHAT_BASE_URL` | `https://ilinkai.weixin.qq.com` | WeChat API endpoint |
| `OP

NCODE_SERVER_PASSWORD` | auto-injected | Desktop app auth password |
| `OP

NCODE_AGENT` | `build` | Default agent type |
| `OP

NCODE_MODEL` | `deepseek-v4-pro` | Default model |

Note: `OP

NCODE_SERVER_PASSWORD` is automatically available in OpenCode's built-in terminal. When running from standalone PowerShell, the bridge auto-detects the desktop port via netstat scan.

## Slash Commands

Send these via WeChat:

| Command | Action |
|---------|--------|
| `/model` | List available models |
| `/model <name>` | Switch model |
| `/reset` | Clear chat history |
| `/status` | Show current model/agent |
| `/agent <type>` | Switch agent |
| `/help` | Show all commands |

## Project Structure

```
wechat-opencode-bridge/
  bridge.js           Main loop (WeChat long-poll + agent dispatch)
  opencode-client.js  Desktop app detection + session management
  wechat-api.js       WeChat HTTP protocol (8 endpoints)
  wechat-auth.js      QR code login flow
  markdown-filter.js  Streaming markdown-to-plaintext filter
  config.js           Configuration (env vars + config.json)
  logger.js           File logger + optional log window
  session-store.js    Context token + sync buffer persistence
  config.json         Saved WeChat token
  openchat.bat        Launcher (added to PATH by setup.bat)
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "OpenCode server not connected" | Ensure OpenCode desktop app is running |
| "Password expired" | Restart from OpenCode built-in terminal once |
| QR code won't scan | PNG image opens automatically; scan from screen |
| Agent replies slowly | Use `/reset` to clear long chat history |
| No reply after 5 min | Agent timeout; try a simpler message first |
