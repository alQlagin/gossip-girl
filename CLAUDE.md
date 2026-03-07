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

`eu.anthropic.claude-3-haiku-20240307-v1:0` — EU cross-region inference profile for Claude 3 Haiku (routes across eu-central-1, eu-west-1, eu-west-3)

## Known gotchas

- **Model access must be accepted** before the agent can invoke any Anthropic model. If you see `AccessDeniedException: Access denied when calling Bedrock`, run:
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

- **Agent alias must point to a version prepared with the correct model.** After changing `foundationModel` in the stack, CDK auto-prepares a new version but does NOT update the alias routing. Check which version the alias targets:
  ```bash
  aws bedrock-agent get-agent-alias --agent-id <ID> --agent-alias-id <ALIAS_ID> \
    --region eu-central-1 --query "agentAlias.routingConfiguration"
  aws bedrock-agent get-agent-version --agent-id <ID> --agent-version <N> \
    --region eu-central-1 --query "agentVersion.foundationModel"
  ```
  Update manually if needed:
  ```bash
  aws bedrock-agent update-agent-alias --agent-id <ID> --agent-alias-id <ALIAS_ID> \
    --agent-alias-name live --routing-configuration agentVersion=<N> --region eu-central-1
  ```

- **IAM policy for system-defined cross-region inference profiles** must include the account ID (not `::`) in the resource ARN:
  `arn:aws:bedrock:*:${account}:inference-profile/eu.anthropic.claude-3-haiku-20240307-v1:0`
