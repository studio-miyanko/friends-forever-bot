import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import { replyMessage } from '../src/discord.js';

// cloudflare:workers only exists inside workerd, so the Worker gets a stand-in base class here.
const STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
registerHooks({ resolve: (specifier, context, next) => (specifier === 'cloudflare:workers' ? { url: STUB, shortCircuit: true } : next(specifier, context)) });
const { default: worker, Ask } = await import('../src/index.js');

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const publicKey = hex(await crypto.subtle.exportKey('raw', keys.publicKey));

async function post(interaction) {
  const body = JSON.stringify(interaction);
  const timestamp = '1760000000';
  const signature = hex(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp + body)));
  const started = [];
  const env = { DISCORD_PUBLIC_KEY: publicKey, ASKS: { newUniqueId: () => 'id', get: () => ({ start: async (job) => started.push(job) }) } };
  const request = new Request('https://bot.test', { method: 'POST', body, headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp } });
  return { response: await worker.fetch(request, env), started };
}

function ask(value, name = 'ffbot') {
  return { id: 'i1', type: 2, token: 'tok', application_id: 'app', data: { name, options: [{ name: 'question', value }] } };
}

function storage() {
  const data = new Map();
  return { data, put: async (key, value) => data.set(key, value), get: async (key) => data.get(key), deleteAll: async () => data.clear(), setAlarm: async () => {} };
}

// An Ask whose model answer is fixed, so the delivery rules run without Gemini or the MCP servers.
async function askWith(text) {
  const object = new Ask({ storage: storage() }, {});
  object.asked = 0;
  object.replyTo = async (question) => {
    object.asked += 1;
    return replyMessage(question, { text });
  };
  await object.start({ question: 'Where?', token: 'tok', appId: 'app' });
  return object;
}

function discord(t, statuses) {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response('{}', { status: statuses[Math.min(sent.length, statuses.length) - 1] });
  });
  return sent;
}

test('refuses anything but signed posts', async () => {
  const env = { DISCORD_PUBLIC_KEY: publicKey };
  assert.equal((await worker.fetch(new Request('https://bot.test'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://bot.test', { method: 'POST', body: '{"type":1}' }), env)).status, 401);
});

test('answers a ping with a pong and refuses unknown interactions', async () => {
  assert.deepEqual(await (await post({ type: 1 })).response.json(), { type: 1 });
  const { response, started } = await post(ask('hi', 'other'));
  assert.equal(response.status, 400);
  assert.equal(started.length, 0);
  assert.equal((await post({ type: 3, data: {} })).response.status, 400);
});

test('answers a blank question at once, without the model', async () => {
  const { response, started } = await post(ask(' \n  '));
  assert.deepEqual(await response.json(), { type: 4, data: { content: 'Ask a question after /ffbot.', flags: 64 } });
  assert.equal(started.length, 0);
});

test('defers a question to its own Ask object, on one line and cut to 300 characters', async () => {
  const { response, started } = await post(ask(`Where\n  does it drop? ${'a'.repeat(400)}`));
  assert.deepEqual(await response.json(), { type: 5 });
  assert.equal(started[0].question.length, 300);
  assert.match(started[0].question, /^Where does it drop\? a/);
  assert.deepEqual({ ...started[0], question: undefined }, { question: undefined, token: 'tok', appId: 'app' });
});

test('the alarm answers once and edits the placeholder', async (t) => {
  const sent = discord(t, [200]);
  const object = await askWith('From Baron Geddon.');
  await object.alarm();
  await object.alarm();

  assert.equal(object.asked, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, '-# Where?\n### From Baron Geddon.');
  assert.equal(object.ctx.storage.data.size, 0);
});

test('a retry resends the saved reply without asking the model again', async (t) => {
  const sent = discord(t, [502, 200]);
  const object = await askWith('Answer.');
  await assert.rejects(object.alarm({ isRetry: false, retryCount: 0 }), /Discord answered 502/);
  await object.alarm({ isRetry: true, retryCount: 1 });

  assert.equal(object.asked, 1);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(object.ctx.storage.data.size, 0);
});

test('a retry after a crash sends a failure note instead of silence', async (t) => {
  const sent = discord(t, [200]);
  const object = await askWith('never used');
  await object.alarm({ isRetry: true, retryCount: 1 });

  assert.equal(object.asked, 0);
  assert.match(sent[0].content, /^-# Where\?\n### Something went wrong/);
});

test('the last retry gives up and clears the job', async (t) => {
  discord(t, [502]);
  const object = await askWith('Answer.');
  await object.alarm({ isRetry: true, retryCount: 6 });
  assert.equal(object.ctx.storage.data.size, 0);
});

test('a broken connection to the MCP servers still ends in a reply', async () => {
  const object = new Ask({ storage: storage() }, {});
  const { content } = await object.replyTo('Where?');
  assert.match(content, /### Something went wrong/);
});
