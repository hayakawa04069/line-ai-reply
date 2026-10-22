import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const FALLBACK = '申し訳ありません。現在回答できません。少し時間をおいて再度お試しください。';

export function validSignature(body, signature, secret) {
  if (typeof signature !== 'string' || !secret) return false;
  const expected = createHmac('sha256', secret).update(body).digest('base64');
  const actual = Buffer.from(signature);
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

export function createServer(config, fetchImpl = fetch) {
  async function post(url, token, body) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`API request failed (${response.status})`);
    return response;
  }

  async function reply(event) {
    if (event.type !== 'message' || !event.replyToken) return;
    // 再配信イベントへの二重返信を避けます（この最小版では再試行しません）。
    if (event.deliveryContext?.isRedelivery) return;
    let text = 'テキストメッセージを送ってください。';
    if (event.message?.type === 'text') {
      try {
        const response = await post('https://api.openai.com/v1/responses', config.openaiKey, {
          model: config.model || 'gpt-4.1-mini',
          instructions: 'あなたはLINEの親切なアシスタントです。日本語で簡潔に回答してください。',
          input: event.message.text,
          max_output_tokens: 600,
          store: false,
        });
        const data = await response.json();
        text = (data.output || []).flatMap(item => item.content || [])
          .filter(item => item.type === 'output_text').map(item => item.text).join('\n').trim() || FALLBACK;
      } catch {
        console.error('OpenAIから回答を取得できませんでした。接続・キー・利用上限を確認してください。');
        text = FALLBACK;
      }
    }
    await post('https://api.line.me/v2/bot/message/reply', config.lineToken, {
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: text.slice(0, 4500) }],
    });
  }

  return http.createServer(async (req, res) => {
    const send = (status, message) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(message);
    };
    if (req.method === 'GET' && req.url === '/') return send(200, 'LINE AI Reply is running');
    if (req.method !== 'POST' || req.url !== '/webhook') return send(404, 'Not found');
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) return send(413, 'Payload too large');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (!validSignature(body, req.headers['x-line-signature'], config.lineSecret)) {
        return send(401, 'Invalid signature');
      }
      let data;
      try { data = JSON.parse(body.toString('utf8')); }
      catch { return send(400, 'Invalid JSON'); }
      if (!Array.isArray(data.events)) return send(400, 'Invalid events');
      await Promise.all(data.events.map(reply));
      send(200, 'OK');
    } catch {
      console.error('Webhook処理に失敗しました。LINEの接続・トークンを確認してください。');
      send(500, 'Webhook failed');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const required = ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'OPENAI_API_KEY'];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) {
    console.error(`.envに設定してください: ${missing.join(', ')}`);
    process.exit(1);
  }
  const port = Number(process.env.PORT || 3000);
  createServer({
    lineSecret: process.env.LINE_CHANNEL_SECRET,
    lineToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    openaiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
  }).listen(port, '0.0.0.0', () => console.log(`Server started on port ${port}`));
}
