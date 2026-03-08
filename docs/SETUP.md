# Setup Guide

Complete setup instructions for deploying the GossipGirl Telegram bot.

## Prerequisites

- AWS CLI configured for `eu-central-1`
- Node.js 20+
- A Telegram account

---

## Step 1 — Create the bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Note the **bot token** (`123456:ABC-DEF...`) and **bot username** (e.g. `GossipGirlBot`)

---

## Step 2 — Accept Bedrock model access

Run once per AWS account/region:

```bash
OFFER_TOKEN=$(aws bedrock list-foundation-model-agreement-offers \
  --model-id anthropic.claude-3-haiku-20240307-v1:0 \
  --region eu-central-1 \
  --query "offers[0].offerToken" --output text)

aws bedrock create-foundation-model-agreement \
  --model-id anthropic.claude-3-haiku-20240307-v1:0 \
  --offer-token "$OFFER_TOKEN" \
  --region eu-central-1
```

---

## Step 3 — Store secrets in SSM

```bash
# Bot token — SecureString (fetched at Lambda cold start)
aws ssm put-parameter \
  --name '/gossip-girl/telegram-bot-token' \
  --value '<BOT_TOKEN>' \
  --type SecureString \
  --region eu-central-1

# Webhook secret — plain String (read at CDK synth time, passed as env var)
WEBHOOK_SECRET=$(openssl rand -hex 32)
aws ssm put-parameter \
  --name '/gossip-girl/telegram-webhook-secret' \
  --value "$WEBHOOK_SECRET" \
  --type String \
  --region eu-central-1

echo "Webhook secret: $WEBHOOK_SECRET"  # save this for Step 5
```

---

## Step 4 — Set bot username and deploy

Edit `lib/gossip-girl-stack.ts` line 13:

```typescript
const BOT_USERNAME = 'GossipGirlBot'; // ← replace with your bot's username (without @)
```

Then deploy:

```bash
npm install
npx cdk deploy
```

Note the `TelegramWebhookUrl` output value.

---

## Step 5 — Register the webhook with Telegram

```bash
BOT_TOKEN="<your-bot-token>"
WEBHOOK_URL="<TelegramWebhookUrl output from cdk deploy>"
WEBHOOK_SECRET="<secret from Step 3>"

curl "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=${WEBHOOK_URL}" \
  -d "secret_token=${WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message"]'

# Verify
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

---

## Step 6 — Verify

1. Send a private message to the bot → it should reply
2. Add the bot to a group:
   - Message without `@mention` → bot should **not** reply
   - Send `@GossipGirlBot hello` → bot should reply
   - Reply to the bot's message → bot should respond
3. Check CloudWatch logs: `TelegramWebhookLambda` and `TelegramProcessorLambda`
4. Send another message in the same chat → verify L1 session memory (context retained)
5. Send a message as the same user from a different chat → verify L2 user memory persists

---

## Redeploying after changes

After changing `foundationModel` in the stack, run `npx cdk deploy`. The alias routing is managed automatically via `routingConfiguration: [{ agentVersion: bedrockAgent.attrAgentVersion }]` in the CDK stack, so it will point to the newly prepared version after each deployment.
