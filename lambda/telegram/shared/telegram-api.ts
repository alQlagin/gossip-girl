const TG_API = 'https://api.telegram.org';

async function tgPost(token: string, method: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  replyToId?: number,
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
  };
  if (replyToId !== undefined) {
    payload.reply_to_message_id = replyToId;
  }

  const res = await tgPost(token, 'sendMessage', payload);
  if (res.ok) return;

  // Telegram returns 400 if Markdown is malformed — retry as plain text
  if (res.status === 400) {
    const plainPayload: Record<string, unknown> = { chat_id: chatId, text };
    if (replyToId !== undefined) plainPayload.reply_to_message_id = replyToId;
    const retryRes = await tgPost(token, 'sendMessage', plainPayload);
    if (!retryRes.ok) {
      console.error('sendMessage plain-text retry failed', retryRes.status, await retryRes.text());
    }
    return;
  }

  console.error('sendMessage failed', res.status, await res.text());
}

export async function sendChatAction(token: string, chatId: number, action: 'typing'): Promise<void> {
  try {
    await tgPost(token, 'sendChatAction', { chat_id: chatId, action });
  } catch {
    // fire-and-forget — never throw
  }
}
