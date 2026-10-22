import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from './server.js';

async function setup(t, fetchImpl) {
  const server = createServer({ lineSecret: 'test-secret', lineToken: 'test-line', openaiKey: 'test-openai' }, fetchImpl);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    send: (events, signature = true) => {
      const body = JSON.stringify({ events });
      return fetch(`${url}/webhook`, {
        method: 'POST', body,
        headers: { 'x-line-signature': signature ? createHmac('sha256', 'test-secret').update(body).digest('base64') : 'invalid' },
      });
    },
  };
}

const event = { type: 'message', replyToken: 'reply-token', message: { type: 'text', text: 'こんにちは' } };

test('health check and LINE verification request', async t => {
  const app = await setup(t, () => assert.fail('Unexpected API call'));
  assert.equal(await (await fetch(app.url)).text(), 'LINE AI Reply is running');
  assert.equal((await app.send([])).status, 200);
});

test('invalid signature is rejected', async t => {
  const app = await setup(t, () => assert.fail('Unexpected API call'));
  assert.equal((await app.send([event], false)).status, 401);
});

test('OpenAI answer is returned to LINE', async t => {
  const calls = [];
  const app = await setup(t, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(url.includes('openai.com')
      ? { output: [{ content: [{ type: 'output_text', text: 'こんにちは！' }] }] }
      : {}));
  });
  assert.equal((await app.send([event])).status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].body.input, 'こんにちは');
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[1].url, 'https://api.line.me/v2/bot/message/reply');
  assert.deepEqual(calls[1].body, { replyToken: 'reply-token', messages: [{ type: 'text', text: 'こんにちは！' }] });
});

test('OpenAI failure sends a friendly fallback', async t => {
  const replies = [];
  const app = await setup(t, async (url, options) => {
    if (url.includes('openai.com')) return new Response('{}', { status: 429 });
    replies.push(JSON.parse(options.body));
    return new Response('{}');
  });
  assert.equal((await app.send([event])).status, 200);
  assert.match(replies[0].messages[0].text, /現在回答できません/);
});

test('image requests text without calling OpenAI', async t => {
  const app = await setup(t, async (url, options) => {
    assert.equal(url, 'https://api.line.me/v2/bot/message/reply');
    assert.equal(JSON.parse(options.body).messages[0].text, 'テキストメッセージを送ってください。');
    return new Response('{}');
  });
  assert.equal((await app.send([{ ...event, message: { type: 'image' } }])).status, 200);
});

test('redelivery and non-message events are ignored', async t => {
  const app = await setup(t, () => assert.fail('Unexpected API call'));
  assert.equal((await app.send([{ ...event, deliveryContext: { isRedelivery: true } }, { type: 'follow' }])).status, 200);
});

test('LINE API failure returns HTTP 500', async t => {
  const app = await setup(t, async () => new Response('{}', { status: 401 }));
  assert.equal((await app.send([{ ...event, message: { type: 'image' } }])).status, 500);
});
