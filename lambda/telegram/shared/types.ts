export interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface ProcessorPayload {
  chatId: number;
  userId: number;
  text: string;        // @mention stripped
  messageId: number;   // for reply_to_message_id in response
}
