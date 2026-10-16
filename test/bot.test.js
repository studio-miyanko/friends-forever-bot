import assert from 'node:assert/strict';
import test from 'node:test';

import { MODELS, answer, callGemini } from '../src/agent.js';
import { deliver, isFromDiscord, replyMessage } from '../src/discord.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const ARMORY = 'https://worldofwarcraft.blizzard.com/worldsoul/eu/armory/character/draenor/moadzarella';
const PORTRAIT = 'https://render.worldofwarcraft.com/eu/character/draenor/222/175356126-avatar.jpg';

// Stands in for the MCP servers, so the loop runs without network.
function fakeTools(results = {}) {
  const calls = [];
  return {
    calls,
    instructions: 'Read long pages to the end.',
    functions: ['search', 'character'].map((name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } })),
    async call({ function: { name } }) {
      calls.push(name);
      return results[name] ?? `Tool error: No tool named ${name}`;
    },
  };
}

function toolCall(name, id = name) {
  return { id, type: 'function', function: { name, arguments: '{}' } };
}

function busy() {
  return new Response('{"error":{"code":503,"message":"This model is currently experiencing high demand."}}', { status: 503 });
}

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

test('feeds tool results back to the model until it answers, with the servers\' notes in its instructions', async () => {
  const seen = [];
  const chat = async (messages) => {
    seen.push(messages.at(-1));
    if (seen.length > 1) return { content: 'Done.' };
    assert.match(messages[0].content, /Today is 2026-10-16\./);
    assert.match(messages[0].content, /Answer only questions about World of Warcraft/);
    assert.match(messages[0].content, /Notes from the tools\nRead long pages to the end\.$/);
    return { content: '', tool_calls: [toolCall('search')] };
  };
  const tools = fakeTools({ search: '- Thunderfury (item) https://www.wowhead.com/forever/item=19019' });

  assert.deepEqual(await answer('Where is Thunderfury?', { apiKey: 'key', tools, chat, today: '2026-10-16' }), { text: 'Done.', character: undefined });
  assert.equal(seen[1].role, 'tool');
  assert.match(seen[1].content, /item=19019/);
});

test('asks for an answer on the last step instead of more lookups', async () => {
  const chat = async (messages) => {
    const asked = messages.at(-1).content?.includes('Answer the question now');
    return asked ? { content: 'Answer.', tool_calls: [toolCall('search')] } : { content: '', tool_calls: [toolCall('search')] };
  };
  const tools = fakeTools({ search: 'nothing' });

  assert.equal((await answer('Where is Thunderfury?', { apiKey: 'key', tools, chat })).text, 'Answer.');
  assert.equal(tools.calls.length, 5);
});

test('caps lookups per step and takes the armory links only from the character tool', async () => {
  const tools = fakeTools({
    character: `Moadzarella, level 90 Dwarf Paladin\nArmory: ${ARMORY}\nPortrait: ${PORTRAIT}`,
    search: 'Armory: https://worldofwarcraft.blizzard.com/made-up',
  });
  let steps = 0;
  const chat = async () => {
    steps += 1;
    if (steps > 1) return { content: 'Moadzarella is a level 90 Holy Paladin.' };
    return { content: '', tool_calls: ['a', 'b', 'c', 'd', 'e'].map((id, index) => toolCall(index === 1 ? 'character' : 'search', id)) };
  };

  const reply = await answer('Moadzarella on Draenor EU?', { apiKey: 'key', tools, chat });
  assert.deepEqual(tools.calls, ['search', 'character', 'search', 'search']);
  assert.deepEqual(reply.character, { armory: ARMORY, portrait: PORTRAIT });
});

test('falls back through the models while they are busy', async (t) => {
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    asked.push(JSON.parse(init.body).model);
    return asked.length < 3 ? busy() : Response.json({ choices: [{ message: { content: 'Hi' } }] });
  });

  assert.equal((await callGemini([], [], 'key')).content, 'Hi');
  assert.deepEqual(asked, MODELS);
});

test('tries every model once more after a short pause when all are busy', async (t) => {
  const asked = [];
  const pauses = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    asked.push(JSON.parse(init.body).model);
    return asked.length <= MODELS.length ? busy() : Response.json({ choices: [{ message: { content: 'Hi' } }] });
  });

  assert.equal((await callGemini([], [], 'key', { pause: async (ms) => pauses.push(ms) })).content, 'Hi');
  assert.deepEqual(asked, [...MODELS, MODELS[0]]);
  assert.deepEqual(pauses, [5000]);
});

test('reports a used-up daily quota at once, and stops at a wrong key', async (t) => {
  let asked = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    asked += 1;
    return new Response('{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}', { status: 429 });
  });
  await assert.rejects(callGemini([], [], 'key', { pause: async () => assert.fail('no second round') }), /daily quota/);
  assert.equal(asked, MODELS.length);

  t.mock.method(globalThis, 'fetch', async () => new Response('API key not valid', { status: 401 }));
  await assert.rejects(callGemini([], [], 'bad'), /answered 401/);
});

test('every reply is a plain message led by a one-sentence summary, and a character links its armory page', () => {
  const text = 'Craft it from two [bindings](https://www.wowhead.com/forever/item=18563) and a quest.\n\n'
    + '- Left binding from Garr\n- Right binding from Baron Geddon\n\nSources: [Thunderfury](https://www.wowhead.com/forever/item=19019)';
  const message = replyMessage('Where does Thunderfury drop?', { text });
  assert.equal(message.content, '-# Where does Thunderfury drop?\n### Craft it from two bindings and a quest.\n'
    + '- Left binding from Garr\n- Right binding from Baron Geddon\n\nSources: [Thunderfury](https://www.wowhead.com/forever/item=19019)');
  assert.equal(message.embeds, undefined);
  assert.equal(message.flags, 1 << 2);
  assert.deepEqual(message.allowed_mentions, { parse: [] });

  const character = replyMessage('Moadzarella?', { text: 'A level 90 Holy Paladin.', character: { armory: ARMORY, portrait: PORTRAIT } });
  assert.equal(character.content, `-# Moadzarella?\n### [A level 90 Holy Paladin.](${ARMORY})`);
});

test('replies stay within Discord\'s message limit', () => {
  const long = replyMessage('q'.repeat(300), { text: `${'a'.repeat(300)}\n\n${'b'.repeat(5000)}` });
  assert.equal(long.content.length, 2000);
  assert.ok(long.content.startsWith(`-# ${'q'.repeat(255)}…\n${'a'.repeat(300)}\n\nb`));
  assert.equal(replyMessage('q', { text: '- just a list' }).content, '-# q\n- just a list');
});

test('Discord limits are waited out and an expired token stops', async (t) => {
  const sent = [];
  const answers = [() => new Response('{"retry_after":0.01}', { status: 429 }), () => Response.json({})];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent.push({ url: String(url), init });
    return answers[sent.length - 1]();
  });

  await deliver('app', 'tok', replyMessage('Where?', { text: 'From Garr.' }));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, 'https://discord.com/api/v10/webhooks/app/tok/messages/@original');
  assert.match(sent[0].init.headers['user-agent'], /^DiscordBot \(https:\/\/github\.com\/studio-miyanko\/friends-forever-bot, /);
  assert.equal(JSON.parse(sent[1].init.body).content, '-# Where?\n### From Garr.');

  t.mock.method(globalThis, 'fetch', async () => new Response('{"code":10015}', { status: 404 }));
  await deliver('app', 'tok', { content: 'x' });
  t.mock.method(globalThis, 'fetch', async () => new Response('busy', { status: 502 }));
  await assert.rejects(deliver('app', 'tok', { content: 'x' }), /Discord answered 502/);
});
