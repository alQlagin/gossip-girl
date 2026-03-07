# Gossip Girl Agent

Bedrock-powered AI agent with two-level memory deployed on AWS.

## Architecture

- API Gateway → Proxy Lambda → Bedrock Agent → Action Lambda
- L1 memory: Bedrock Agent session summaries (per `sessionId`)
- L2 memory: AgentCore Memory (per `user_id`, 90-day retention)

## Deploy

```bash
npm install
npx cdk deploy
```

## Testing with curl

### Send a message (new session)

```bash
curl -X POST https://fidzpa6vm6.execute-api.eu-central-1.amazonaws.com/prod/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Who are you?", "user_id": "blair"}'
```

### Continue a session

```bash
curl -X POST https://fidzpa6vm6.execute-api.eu-central-1.amazonaws.com/prod/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What did I say before?", "user_id": "blair", "session_id": "<session_id>"}'
```

### Expected response

```json
{"response": "XOXO...", "user_id": "blair", "session_id": "abc-123"}
```

### Error responses

| Status | Meaning |
|--------|---------|
| 400 | Missing or invalid `message` / `user_id` |
| 500 | Agent invocation failed |

## Model

`anthropic.claude-3-haiku-20240307-v1:0` — Claude 3 Haiku (eu-central-1)
