# Gossip Girl Agent

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
[Bedrock Agent → Action Lambda]
```

- L1 memory: Bedrock Agent session summaries (per chat, `sessionId = tg-<chatId>`)
- L2 memory: AgentCore Memory (per user, `memoryId = tg-<userId>`, 90-day retention)

## Setup

See [docs/SETUP.md](docs/SETUP.md) for bot creation, SSM parameters, and webhook registration.

## Deploy

```bash
npm install
npx cdk deploy
```

## Model

`eu.anthropic.claude-sonnet-4-5-20250929-v1:0` — EU cross-region inference profile (routes across eu-central-1, eu-west-1, eu-west-3)

## Known gotchas

- **Model access must be accepted** before the agent can invoke any Anthropic model. See [docs/SETUP.md](docs/SETUP.md) Step 2.

- **IAM policy for system-defined cross-region inference profiles** must include the account ID (not `::`) in the resource ARN:
  `arn:aws:bedrock:*:${account}:inference-profile/eu.anthropic.claude-sonnet-4-5-20250929-v1:0`
