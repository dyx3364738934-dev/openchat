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
| `OPENCODE_SERVER_PASSWORD` | auto-injected | Desktop app auth password |
| `OPENCODE_AGENT` | `build` | Default agent type |
| `OPENCODE_MODEL` | `deepseek-v4-pro` | Default model |

Note: `OPENCODE_SERVER_PASSWORD` is automatically available in OpenCode's built-in terminal. When running from standalone PowerShell, the bridge auto-detects the desktop port via netstat scan.

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

## Changelog

### v1.2.0

**Bug Fixes:**
- Fixed QR login using wrong field (`qrcode` UUID instead of `qrcode_img_content` URL) — scanning now correctly binds WeChat chat
- Fixed session lock returning Promise instead of session ID on concurrent requests
- Fixed `/model` interactive mode trapping users — other `/` commands now exit the mode
- Fixed non-`/` messages not clearing interactive context (`/model` selection state)
- Fixed silent failure when switching model/agent fails to create new session
- Fixed `isNaN("")` treating empty string as number in model selection
- Fixed `splitLongText` cutting inside code blocks — now splits at code block boundaries
- Fixed image/file/video messages silently discarded with zero feedback
- Fixed `extractTextFromItemList` only returning first text item — now concatenates all
- Fixed console log missing timestamp and level info
- Removed redundant manual `Content-Length` header (let fetch handle it)
- Fixed environment variable names broken by newlines in comments/README
- Fixed `allowFrom` config breaking when value is an array
- Fixed `markdown-filter` only stripping H5/H6 `#` marks — now strips H1-H6
- Fixed `~~` strikethrough only skipping single `~` — now properly handles `~~text~~`
- Fixed `fetchAvailableModels` silently swallowing errors with empty `catch {}`
- Fixed `getUpdates` treating all AbortError as normal timeout — now only silences timeout-originated aborts

**Performance:**
- Context token persistence changed from sync write-every-time to 500ms debounced async
- Logger changed from sync `appendFileSync` to async buffered queue (`fsp.appendFile`)
- Sessions Map now has 100-entry LRU eviction limit to prevent memory leaks

**Robustness:**
- Long-poll timeout value from server now clamped to [10s, 120s]
- Graceful shutdown now waits up to 10s for in-flight messages to complete
- `opencodeAutoStart` env var now correctly handles `"0"` and empty string as false
- `OPENCODE_` prefix unified as exported constant from `config.js`

**Security:**
- QR login debug output now uses `logger.debug` instead of `console.log` (no sensitive data in production)

### v1.0.0

- Initial release