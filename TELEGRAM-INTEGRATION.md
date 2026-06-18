# Opencode Telegram Integration

将 Telegram bot 作为 opencode CLI 的内置 subcommand 集成。

## 使用方式

```bash
# 使用前
export TELEGRAM_BOT_TOKEN='your-bot-token'
export TELEGRAM_ALLOWED_USERS='123456789,987654321'  # 可选
opencode telegram

# 或指定选项
opencode telegram --token 'xxx' --allowed-users '123,456'

# 别称
opencode tg --token 'xxx'
```

## 修改的文件

### 1. `packages/opencode/src/cli/cmd/telegram.ts` (新建)

Telegram CLI 命令实现，包含：
- yargs 命令定义
- 启动 opencode 服务器
- 创建 Telegraf bot
- 命令处理 (`/start`, `/new`, `/abort`, `/status`, `/share`, `/help`)
- 文字消息处理（自动创建 session + 发送 prompt）
- SSE 事件订阅（将 AI 回复、工具结果推送到 Telegram）

### 2. `packages/opencode/package.json`

添加 `telegraf` 依赖：
```diff
+ "telegraf": "^4.16.3",
```

### 3. `packages/opencode/src/index.ts`

注册 Telegram 命令：
```diff
+ import { TelegramCommand } from "./cli/cmd/telegram"
  // ...
- .command(DbCommand)
+ .command(DbCommand)
+ .command(TelegramCommand)
  .fail(
```

## 环境变量

| 变量 | CLI 选项 | 说明 |
|------|----------|------|
| `TELEGRAM_BOT_TOKEN` | `--token` | Telegram bot token（必须设其中一个） |
| `TELEGRAM_ALLOWED_USERS` | `--allowed-users` | 允许的 chat ID，逗号分隔，留空=允许所有 |

## 技术架构

```
opencode telegram
    │
    ├─ Server.listen(opts)     # 启动 opencode HTTP 服务器（内建）
    ├─ createOpencodeClient()  # SDK 客户端，连接本地服务器
    └─ Telegraf.launch()      # Telegram bot，长轮询
```

所有接口（TUI、Web、Telegram、Slack）都通过 SDK 连接到同一套 HTTP API，不共享实现代码。

## Bot 命令

| 命令 | 功能 |
|------|------|
| `/start` | 欢迎说明 |
| `/new` | 创建新 session |
| `/abort` | 中止当前任务 |
| `/status` | 查看 session ID |
| `/share` | 获取分享链接 |
| `/help` | 帮助说明 |
| 直接发消息 | 自动创建 session + 发送 prompt |

## 事件流处理

通过 `client.event.subscribe()` 订阅 SSE 事件：
- `message.part.updated` (type: "text") → 当文字内容变化时推送到 Telegram
- `message.part.updated` (type: "tool", status: "completed") → 工具完成时显示工具名称
- 内容和工具名称截断为 4000/2000 字符（Telegram 限制）

## 限制

- 单条消息最大 4096 字符（Telegram API 限制）
- 长回复会被截断，后续更新会发送新消息
- 不支持图片、语音等多媒体消息
