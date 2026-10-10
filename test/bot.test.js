import assert from 'node:assert/strict';
import test from 'node:test';

import { answer } from '../src/agent.js';
import { clip, isFromDiscord } from '../src/discord.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');

test('accepts only interactions signed with the app key', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = hex(await crypto.subtle.exportKey('raw', keys.publicKey));
  const body = '{"type":1}';
  const timestamp = '1760000000';
  const signature = hex(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp + body)));
  const request = new Request('https://bot.test', {
    method: 'POST',
    headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp },
  });

  assert.equal(await isFromDiscord(request, body, publicKey), true);
  assert.equal(await isFromDiscord(request, '{"type":2}', publicKey), false);
  assert.equal(await isFromDiscord(new Request('https://bot.test'), body, publicKey), false);
});

test('feeds tool results back to the model until it answers', async () => {
  const turns = [];
  const chat = async (messages, tools) => {
    turns.push(messages.at(-1));
    if (turns.length === 1) {
      assert.deepEqual(tools.map((tool) => tool.function.name).sort(), ['get_news', 'get_page', 'search']);
      return { content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'missing_tool', arguments: '{}' } }] };
    }
    return { content: 'Done.' };
  };

  assert.equal(await answer('Where is Thunderfury?', 'key', chat), 'Done.');
  assert.equal(turns[1].role, 'tool');
  assert.match(turns[1].content, /missing_tool/);
});

test('keeps replies within Discord’s 2000 characters', () => {
  assert.equal(clip('a'.repeat(2500)).length, 2000);
  assert.equal(clip('short'), 'short');
});
