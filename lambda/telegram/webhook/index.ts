import { timingSafeEqual } from 'node:crypto';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { TelegramUpdate, TelegramMessage, ProcessorPayload } from '../shared/types';

const lambdaClient = new LambdaClient({});

const PROCESSOR_FUNCTION_ARN = process.env.PROCESSOR_FUNCTION_ARN!;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!;
const BOT_USERNAME = process.env.BOT_USERNAME!;

interface FunctionUrlEvent {
  headers?: Record<string, string>;
  body?: string;
  requestContext?: { http?: { method?: string } };
}

function ok(): { statusCode: number; body: string } {
  return { statusCode: 200, body: '' };
}

function forbidden(): { statusCode: number; body: string } {
  return { statusCode: 403, body: 'Forbidden' };
}

function validateSecret(headers: Record<string, string>): boolean {
  const incoming = headers['x-telegram-bot-api-secret-token'] ?? '';
  if (incoming.length !== WEBHOOK_SECRET.length) return false;
  const a = Buffer.from(incoming);
  const b = Buffer.from(WEBHOOK_SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isMentioned(message: TelegramMessage): boolean {
  const entities = message.entities ?? [];
  for (const entity of entities) {
    if (entity.type === 'mention') {
      const mention = message.text?.slice(entity.offset, entity.offset + entity.length) ?? '';
      if (mention.toLowerCase() === `@${BOT_USERNAME.toLowerCase()}`) return true;
    }
  }
  return false;
}

function stripMention(text: string): string {
  return text.replace(new RegExp(`@${BOT_USERNAME}`, 'gi'), '').trim();
}

export const handler = async (event: FunctionUrlEvent) => {
  // Validate secret token
  if (!validateSecret(event.headers ?? {})) {
    return forbidden();
  }

  // Parse update — always return 200 to Telegram even on parse errors
  let update: TelegramUpdate;
  try {
    update = JSON.parse(event.body ?? '{}') as TelegramUpdate;
  } catch {
    console.warn('Failed to parse Telegram update body');
    return ok();
  }

  const message = update.message;
  if (!message || !message.text || !message.from || message.from.is_bot) {
    return ok();
  }

  const isPrivate = message.chat.type === 'private';
  const mentionedBot = isMentioned(message);
  const repliedToBot = message.reply_to_message?.from?.is_bot === true &&
    message.reply_to_message?.from?.username === BOT_USERNAME;

  // In group chats, only respond when explicitly addressed
  if (!isPrivate && !mentionedBot && !repliedToBot) {
    return ok();
  }

  const rawText = message.text;
  const text = isPrivate ? rawText.trim() : stripMention(rawText);

  if (!text) return ok();

  const payload: ProcessorPayload = {
    chatId: message.chat.id,
    userId: message.from.id,
    text,
    messageId: message.message_id,
    chatType: message.chat.type,
    chatTitle: message.chat.title,
    fromFirstName: message.from.first_name,
    fromUsername: message.from.username,
  };

  // Fire-and-forget async invocation
  await lambdaClient.send(new InvokeCommand({
    FunctionName: PROCESSOR_FUNCTION_ARN,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify(payload)),
  }));

  return ok();
};
