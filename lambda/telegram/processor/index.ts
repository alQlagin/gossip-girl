import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
  InvokeAgentCommandOutput,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
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

async function getSessionStatus(sessionId: string): Promise<'allowed' | 'blocked' | 'unknown'> {
  const res = await ddb.send(new GetCommand({
    TableName: SESSION_TABLE_NAME,
    Key: { PK: `SESSION#${sessionId}`, SK: 'METADATA' },
  }));
  const status = res.Item?.status as string | undefined;
  if (status === 'allowed') return 'allowed';
  if (status === 'blocked') return 'blocked';
  return 'unknown';
}

async function listAdminUserIds(): Promise<number[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: SESSION_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': 'ADMINS' },
  }));
  return (res.Items ?? [])
    .map(item => item.SK as string)
    .map(sk => parseInt(sk.replace('tg-', ''), 10))
    .filter(id => !isNaN(id));
}

async function notifyAdminsAccessRequest(
  botToken: string,
  payload: ProcessorPayload,
): Promise<void> {
  const adminIds = await listAdminUserIds();
  if (adminIds.length === 0) return;

  const { chatId, userId, chatType, chatTitle, fromFirstName, fromUsername } = payload;
  const sessionId = `tg-${Math.abs(chatId)}`;
  const userLink = `tg://user?id=${userId}`;
  const displayName = fromUsername
    ? `${fromFirstName} (@${fromUsername})`
    : (fromFirstName ?? String(userId));
  const chatDisplay = chatTitle
    ?? (chatType === 'private' ? `Private chat with ${displayName}` : String(chatId));

  const lines = [
    '🔐 *Access Request*',
    '',
    `From: [${displayName}](${userLink})`,
    `Chat: ${chatDisplay} \\(${chatType}\\)`,
    `Chat ID: \`${chatId}\``,
    `Session ID: \`${sessionId}\``,
    '',
    'To allow this chat, say:',
    `_allow session ${sessionId} for user tg\\-${userId}_`,
  ];

  await Promise.allSettled(
    adminIds.map(adminId => sendMessage(botToken, adminId, lines.join('\n'))),
  );
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

  // Access control — deny by default
  const status = await getSessionStatus(sessionId);
  if (status !== 'allowed') {
    await sendMessage(botToken, chatId, 'ask admin to grant you access to gossips', messageId);
    if (status === 'unknown') {
      // Notify admins about the access request (fire-and-forget)
      notifyAdminsAccessRequest(botToken, payload).catch(err =>
        console.error('Failed to notify admins:', err),
      );
    }
    return;
  }

  try {
    await sendChatAction(botToken, chatId, 'typing');

    const result = await bedrockClient.send(new InvokeAgentCommand({
      agentId: AGENT_ID,
      agentAliasId: AGENT_ALIAS_ID,
      sessionId,
      memoryId,
      inputText: text,
      enableTrace: false,
      sessionState: {
        sessionAttributes: { requestorUserId: memoryId },
      },
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
