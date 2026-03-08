# Gossip Girl

Bedrock-powered AI agent exposed as a Telegram bot, deployed on AWS.

## Architecture

```
Telegram user
  ↓  (POST webhook)
[Lambda Function URL]
  ↓
[TelegramWebhookLambda]  — validates secret token, fires async invoke, returns 200
  ↓  (InvocationType: Event)
[TelegramProcessorLambda] — upserts session, calls Bedrock, sends reply via Bot API
  ↓
[Bedrock Agent]
  ↓
[Action Lambda]
```

Memory:
- **L1** — Bedrock Agent session summaries (per chat, `sessionId = tg-<chatId>`)
- **L2** — AgentCore Memory, 90-day retention (per user, `memoryId = tg-<userId>`)

## Setup

See [docs/SETUP.md](docs/SETUP.md) for the full one-time setup guide (bot creation, SSM parameters, webhook registration).

## Deploy

```bash
npm install
npx cdk deploy
```

## Model

`eu.anthropic.claude-3-haiku-20240307-v1:0` — EU cross-region inference profile (routes across eu-central-1, eu-west-1, eu-west-3)
