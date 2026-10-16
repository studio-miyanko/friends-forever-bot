import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// cloudflare:workers only exists inside workerd, so the Gateway gets a stand-in base class here.
const STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
registerHooks({ resolve: (specifier, context, next) => (specifier === 'cloudflare:workers' ? { url: STUB, shortCircuit: true } : next(specifier, context)) });
const { Gateway, mayAsk, mentionQuestion } = await import('../src/gateway.js');

const BOT = '1560632632063041536';

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 1;
  }

  accept() {}

  addEventListener() {}

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code) {
    this.closedWith = code;
    this.readyState = 3;
  }
}

function storage() {
  const data = new Map();
  let alarm = null;
  return {
    data,
    get: async (key) => data.get(key),
    put: async (key, value) => data.set(key, value),
    delete: async (key) => data.delete(key),
    getAlarm: async () => alarm,
    setAlarm: async (at) => {
      alarm = at;
    },
  };
}

// A Gateway whose socket and Discord calls are fakes, so the protocol runs without network.
function gatewayWith(t) {
  const sockets = [];
  const posted = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init.headers.upgrade === 'websocket') {
      sockets.push(new FakeSocket(String(url)));
      return { status: 101, webSocket: sockets.at(-1) };
    }
    posted.push({ url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) });
    return Response.json({ id: `reply${posted.length}` });
  });
  const asks = [];
  const env = { DISCORD_TOKEN: 'tok', ASKER_ROLES: 'admin,member', EVENTS_CHANNEL: 'events1', ASKS: { newUniqueId: () => 'id', get: () => ({ start: async (job) => asks.push(job) }) } };
  return { gateway: new Gateway({ storage: storage() }, env), sockets, posted, asks };
}

const ready = { op: 0, s: 1, t: 'READY', d: { session_id: 's1', resume_gateway_url: 'wss://resume.discord.gg', user: { id: BOT } } };

function mention(id, roles, content = `<@${BOT}> where does Thunderfury drop?`) {
  return { op: 0, s: 2, t: 'MESSAGE_CREATE', d: { id, channel_id: 'c1', guild_id: 'g1', author: { id: 'u1' }, member: { roles }, content } };
}

test('reads the question after a mention and ignores everything else', () => {
  const message = (content, author = { id: 'u1' }) => ({ guild_id: 'g1', author, content });
  assert.equal(mentionQuestion(message(`<@${BOT}> where does Thunderfury drop?`), BOT), 'where does Thunderfury drop?');
  assert.equal(mentionQuestion(message(`so <@!${BOT}>   which class tanks best?`), BOT), 'so which class tanks best?');
  assert.equal(mentionQuestion(message(`<@${BOT}>`), BOT), '');
  assert.equal(mentionQuestion(message('no mention here'), BOT), undefined);
  assert.equal(mentionQuestion(message(`<@${BOT}> hi`, { id: 'b1', bot: true }), BOT), undefined);
  assert.equal(mentionQuestion(message(`<@${BOT}> ${'q'.repeat(400)}`), BOT).length, 300);
});

test('only members and admins may ask', () => {
  assert.equal(mayAsk({ roles: ['other', 'member'] }, ['admin', 'member']), true);
  assert.equal(mayAsk({ roles: ['other'] }, ['admin', 'member']), false);
  assert.equal(mayAsk(undefined, ['member']), false);
});

test('logs in, keeps the heartbeat, answers a member once and turns a guest away', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { gateway, sockets, posted, asks } = gatewayWith(t);
  await gateway.connect();
  await gateway.receive({ op: 10, d: { heartbeat_interval: 41250 } });
  assert.equal(sockets[0].url, 'https://gateway.discord.gg/?v=10&encoding=json');
  assert.deepEqual(sockets[0].sent[0], { op: 2, d: { token: 'tok', intents: 66049, properties: { os: 'linux', browser: 'friends-forever-bot', device: 'friends-forever-bot' } } });

  await gateway.receive(ready);
  t.mock.timers.tick(41250);
  assert.deepEqual(sockets[0].sent[1], { op: 1, d: 1 });

  await gateway.receive(mention('m1', ['member']));
  await gateway.receive(mention('m1', ['member']));
  await gateway.receive(mention('m2', []));
  await gateway.receive(mention('m3', ['member'], `<@${BOT}>`));
  assert.deepEqual(asks, [{ question: 'where does Thunderfury drop?', target: { channelId: 'c1', messageId: 'reply1' } }]);
  assert.equal(posted[0].url, 'https://discord.com/api/v10/channels/c1/messages');
  assert.equal(posted[0].auth, 'Bot tok');
  assert.deepEqual(posted[0].body, {
    content: '-# Looking that up…',
    message_reference: { message_id: 'm1', fail_if_not_exists: false },
    allowed_mentions: { parse: [], replied_user: false },
  });
  assert.match(posted[1].body.content, /^Only members can ask me/);
  assert.match(posted[2].body.content, /^Ask me a WoW question/);
});

test('posts every new scheduled event to the events channel once, as its link', async (t) => {
  const { gateway, posted } = gatewayWith(t);
  await gateway.connect();
  await gateway.receive(ready);
  const created = { op: 0, s: 3, t: 'GUILD_SCHEDULED_EVENT_CREATE', d: { id: 'e1', guild_id: 'g1', creator_id: 'u1', name: 'Molten Core' } };
  await gateway.receive(created);
  await gateway.receive(created);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, 'https://discord.com/api/v10/channels/events1/messages');
  assert.deepEqual(posted[0].body, { content: '-# New event by <@u1>\nhttps://discord.com/events/g1/e1', allowed_mentions: { parse: [] } });
  gateway.drop();
});

test('a session from before new intents logs in fresh instead of resuming', async (t) => {
  const { gateway, sockets } = gatewayWith(t);
  await gateway.ctx.storage.put('session', { id: 'old', url: 'wss://resume.discord.gg', botId: BOT, seq: 9, intents: 513 });
  await gateway.connect();
  await gateway.receive({ op: 10, d: { heartbeat_interval: 41250 } });
  assert.equal(sockets[0].sent[0].op, 2);
  gateway.drop();
});

test('a reconnect request resumes the session on the address Discord gave', async (t) => {
  const { gateway, sockets } = gatewayWith(t);
  await gateway.connect();
  await gateway.receive({ op: 10, d: { heartbeat_interval: 41250 } });
  await gateway.receive(ready);
  await gateway.receive({ op: 7, d: null });

  assert.equal(sockets[0].closedWith, 4000);
  assert.equal(sockets[1].url, 'https://resume.discord.gg/?v=10&encoding=json');
  await gateway.receive({ op: 10, d: { heartbeat_interval: 41250 } });
  assert.deepEqual(sockets[1].sent[0], { op: 6, d: { token: 'tok', session_id: 's1', seq: 1 } });
  gateway.drop();
});

test('the watchdog reconnects a silent connection, and a wrong token stops it until the next cron', async (t) => {
  const { gateway, sockets } = gatewayWith(t);
  await gateway.ensure();
  assert.ok(await gateway.ctx.storage.getAlarm());
  await gateway.alarm();
  assert.equal(sockets.length, 1);

  await gateway.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  gateway.lastAck = Date.now() - 10_000;
  await gateway.alarm();
  assert.equal(sockets.length, 2);

  await gateway.closed(sockets[1], 4004);
  assert.equal(await gateway.ctx.storage.get('stopped'), 4004);
  await gateway.alarm();
  assert.equal(sockets.length, 2);
  await gateway.ensure();
  assert.equal(await gateway.ctx.storage.get('stopped'), undefined);
});
