import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
  InvokeAgentCommandOutput,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { sendMessage, sendChatAction } from '../shared/telegram-api';
import { ProcessorPayload } from '../shared/types';

const bedrockClient = new BedrockAgentRuntimeClient({});
const ssmClient = new SSMClient({});
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const AGENT_ID = process.env.AGENT_ID!;
const AGENT_ALIAS_ID = process.env.AGENT_ALIAS_ID!;
const SESSION_TABLE_NAME = process.env.SESSION_TABLE_NAME!;
const BOT_TOKEN_PARAM = process.env.BOT_TOKEN_PARAM!;

// Cached at module scope — fetched once per cold start
let cachedBotToken: string | undefined;

async function getBotToken(): Promise<string> {
  if (cachedBotToken) return cachedBotToken;
  const res = await ssmClient.send(new GetParameterCommand({
    Name: BOT_TOKEN_PARAM,
    WithDecryption: true,
  }));
  cachedBotToken = res.Parameter?.Value;
  if (!cachedBotToken) throw new Error('Bot token not found in SSM');
  return cachedBotToken;
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

async function upsertSession(sessionId: string, userId: string): Promise<void> {
  try {
    await ddb.send(new PutCommand({
      TableName: SESSION_TABLE_NAME,
      Item: {
        PK: `SESSION#${sessionId}`,
        SK: 'METADATA',
        user_id: userId,
        created_at: new Date().toISOString(),
        status: 'allowed',
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (err: unknown) {
    // Item already exists — that's fine
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
}

export const handler = async (payload: ProcessorPayload): Promise<void> => {
  const { chatId, userId, text, messageId } = payload;

  const sessionId = `tg-${Math.abs(chatId)}`;
  const memoryId = `tg-${userId}`;

  let botToken: string;
  try {
    botToken = await getBotToken();
  } catch (err) {
    console.error('Failed to fetch bot token:', err);
    return;
  }

  try {
    // Fire typing indicator and upsert session in parallel
    await Promise.all([
      sendChatAction(botToken, chatId, 'typing'),
      upsertSession(sessionId, memoryId),
    ]);

    const result = await bedrockClient.send(new InvokeAgentCommand({
      agentId: AGENT_ID,
      agentAliasId: AGENT_ALIAS_ID,
      sessionId,
      memoryId,
      inputText: text,
      enableTrace: false,
    }));

    const agentResponse = await collectAgentResponse(result.completion);
    const replyText = agentResponse.trim() || '(no response)';
    if (!agentResponse.trim()) console.warn('Empty response from Bedrock agent');

    await sendMessage(botToken, chatId, replyText, messageId);
  } catch (err) {
    console.error('Processor error:', err);
    try {
      await sendMessage(botToken, chatId, 'Sorry, something went wrong. XOXO \u{1F48B}', messageId);
    } catch (sendErr) {
      console.error('Failed to send error message to user:', sendErr);
    }
  }
};
