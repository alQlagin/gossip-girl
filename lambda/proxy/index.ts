/**
 * API Gateway proxy Lambda for GossipGirl agent.
 *
 * Request body (JSON):
 *   - message    {string}  required  — user's input text
 *   - user_id    {string}  required  — identifies the actor; used as memoryId for L2 user memory
 *   - session_id {string}  optional  — identifies the conversation; auto-generated if absent
 *
 * Response body (JSON):
 *   - response   {string}  — agent's reply
 *   - user_id    {string}  — echoed back for client convenience
 *   - session_id {string}  — use this to continue the same session in subsequent requests
 *
 * Memory levels:
 *   L1 (session):      Bedrock Agent SESSION_SUMMARY — scoped by sessionId
 *   L2 (user/actor):   AgentCore Memory (episodic + semantic) — scoped by memoryId = user_id
 *
 * Session enforcement:
 *   All sessions must be pre-registered in DynamoDB with status="allowed".
 *   Unknown or blocked sessions receive 403. Seed the first session manually via:
 *     aws dynamodb put-item --table-name GossipGirlSessions ...
 */

import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
  InvokeAgentCommandOutput,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const client = new BedrockAgentRuntimeClient({});
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const AGENT_ID = process.env.AGENT_ID!;
const AGENT_ALIAS_ID = process.env.AGENT_ALIAS_ID!;
const SESSION_TABLE_NAME = process.env.SESSION_TABLE_NAME!;

interface RequestBody {
  message?: string;
  user_id?: string;
  session_id?: string;
}

interface ApiGatewayEvent {
  body?: string | null;
  httpMethod?: string;
}

interface ApiGatewayResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function response(statusCode: number, body: Record<string, unknown>): ApiGatewayResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

async function checkSession(sessionId: string): Promise<{ status?: string } | null> {
  const result = await ddb.send(new GetCommand({
    TableName: SESSION_TABLE_NAME,
    Key: { PK: `SESSION#${sessionId}`, SK: 'METADATA' },
  }));
  return (result.Item as { status?: string } | undefined) ?? null;
}

async function collectAgentResponse(stream: InvokeAgentCommandOutput['completion']): Promise<string> {
  let text = '';
  if (!stream) return text;
  for await (const event of stream) {
    if (event.chunk?.bytes) {
      text += Buffer.from(event.chunk.bytes).toString('utf-8');
    }
  }
  return text;
}

export const handler = async (event: ApiGatewayEvent): Promise<ApiGatewayResponse> => {
  // Parse request body
  let body: RequestBody = {};
  try {
    body = JSON.parse(event.body ?? '{}') as RequestBody;
  } catch {
    return response(400, { error: 'Invalid JSON in request body' });
  }

  const { message, user_id, session_id = crypto.randomUUID() } = body;

  // Validate required fields
  if (!message || typeof message !== 'string' || message.trim() === '') {
    return response(400, { error: 'message is required and must be a non-empty string' });
  }
  if (!user_id || typeof user_id !== 'string' || user_id.trim() === '') {
    return response(400, { error: 'user_id is required — it identifies the actor and scopes long-term (L2) memory' });
  }

  // Session allowlist enforcement — reject unknown or blocked sessions
  const sessionItem = await checkSession(session_id);
  if (!sessionItem || sessionItem.status !== 'allowed') {
    return response(403, { error: 'Session not allowed', session_id });
  }

  try {
    const command = new InvokeAgentCommand({
      agentId: AGENT_ID,
      agentAliasId: AGENT_ALIAS_ID,
      // L1: session-scoped memory (SESSION_SUMMARY)
      sessionId: session_id,
      // L2: user/actor-scoped long-term memory (AgentCore Memory)
      memoryId: user_id,
      inputText: message.trim(),
      enableTrace: false,
    });

    const result = await client.send(command);
    const agentResponse = await collectAgentResponse(result.completion);

    return response(200, {
      response: agentResponse,
      user_id,
      session_id,
    });
  } catch (err) {
    const error = err as Error;
    console.error('Error invoking Bedrock agent:', error);
    return response(500, { error: 'Failed to get response from agent', details: error.message });
  }
};
