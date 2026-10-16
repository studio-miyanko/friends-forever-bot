import { DurableObject } from 'cloudflare:workers';

import pkg from '../package.json' with { type: 'json' };
import { COMMAND } from './command.js';
import { botRequest, clip } from './discord.js';

const GATEWAY = 'https://gateway.discord.gg/?v=10&encoding=json';

// GUILDS, GUILD_MESSAGES and GUILD_SCHEDULED_EVENTS. A message that mentions the bot carries its text
// without the privileged Message Content intent.
const INTENTS = (1 << 0) | (1 << 9) | (1 << 16);
const WATCHDOG_MS = 60_000;
const RECONNECT_MS = 3000;
const MAX_QUESTION = COMMAND.options[0].max_length;
const HANDLED_MAX = 50;
const EVENT_PREFIX = 'event:';

const DISPATCH = 0;
const HEARTBEAT = 1;
const IDENTIFY = 2;
const RESUME = 6;
const RECONNECT = 7;
const INVALID_SESSION = 9;
const HELLO = 10;
const HEARTBEAT_ACK = 11;
const OPEN = 1;

// Closing with 1000 or 1001 would end the session, any other code keeps it resumable.
const RESUMABLE_CLOSE = 4000;

// After these close codes every reconnect fails the same way: a wrong token, or intents Discord refuses.
const FATAL_CLOSES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

const THINKING = '-# Looking that up…';
const ONLY_MEMBERS = 'Only members can ask me. Ask an admin to become a member.';
const HOW_TO_ASK = 'Ask me a WoW question right after the mention.';

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// The question in a message that mentions the bot, without the mention. Undefined for any other message.
export function mentionQuestion(message, botId) {
  const content = message.content ?? '';
  if (!botId || message.author?.bot || !message.guild_id || !new RegExp(`<@!?${botId}>`).test(content)) return undefined;
  return clip(content.replace(new RegExp(`<@!?${botId}>`, 'g'), ' ').replace(/\s+/g, ' ').trim(), MAX_QUESTION);
}

// Members and admins may ask. Discord sends the asker's roles along with the message.
export function mayAsk(member, askerRoles) {
  return Boolean(member?.roles?.some((role) => askerRoles.includes(role)));
}

// Replies without pinging the asker, who is reading along anyway.
function reply(token, message, content) {
  return botRequest(token, 'POST', `/channels/${message.channel_id}/messages`, {
    content,
    message_reference: { message_id: message.id, fail_if_not_exists: false },
    allowed_mentions: { parse: [], replied_user: false },
  });
}

// Holds the bot's one Gateway connection, which Discord needs to send it messages at all.
// An alarm checks it every minute and reconnects after a deploy or an outage. The cron trigger starts the alarm.
export class Gateway extends DurableObject {
  async ensure() {
    // A stop after a wrong token gets another try, so a fixed secret takes effect without a manual reset.
    await this.ctx.storage.delete('stopped');
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async alarm() {
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    if (await this.ctx.storage.get('stopped')) return;
    const silent = this.interval && Date.now() - this.lastAck > this.interval * 2 + 5000;
    if (!this.socket || silent) return this.connect();

    // The sequence number is saved once a minute, so a resume after eviction replays at most a minute of events.
    const session = await this.ctx.storage.get('session');
    if (session && session.seq !== this.seq) await this.ctx.storage.put('session', { ...session, seq: this.seq });
  }

  async connect() {
    this.drop(RESUMABLE_CLOSE);
    const session = await this.ctx.storage.get('session');
    const url = session?.url ? `${session.url.replace(/^wss:/, 'https:')}/?v=10&encoding=json` : GATEWAY;
    const response = await fetch(url, { headers: { upgrade: 'websocket' } });
    const socket = response.webSocket;
    if (!socket) throw new Error(`Gateway answered ${response.status}`);
    socket.accept();
    this.socket = socket;
    this.seq = session?.seq ?? null;
    this.lastAck = Date.now();
    socket.addEventListener('message', (event) => this.receive(JSON.parse(event.data)).catch((err) => console.log('gateway event failed', err.message)));
    socket.addEventListener('close', (event) => this.closed(socket, event.code));
  }

  drop(code) {
    clearInterval(this.timer);
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close(code);
    } catch {
      // Already closed.
    }
  }

  async closed(socket, code) {
    if (socket !== this.socket) return;
    this.drop();
    if (FATAL_CLOSES.has(code)) {
      console.log('gateway stopped', code);
      return this.ctx.storage.put('stopped', code);
    }
    console.log('gateway closed', code);

    // The alarm would reconnect within a minute anyway. The short wait keeps a crash loop from hammering Discord.
    await sleep(RECONNECT_MS);
    if (!this.socket) await this.connect();
  }

  send(payload) {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(payload));
  }

  async receive({ op, d, s, t }) {
    if (s) this.seq = s;
    if (op === HELLO) {
      this.interval = d.heartbeat_interval;
      clearInterval(this.timer);
      this.timer = setInterval(() => this.send({ op: HEARTBEAT, d: this.seq }), this.interval);
      return this.login();
    }
    if (op === HEARTBEAT) return this.send({ op: HEARTBEAT, d: this.seq });
    if (op === HEARTBEAT_ACK) {
      this.lastAck = Date.now();
      return undefined;
    }
    if (op === RECONNECT) return this.connect();
    if (op === INVALID_SESSION) {
      // False means the session is gone, so the next connection logs in fresh. Discord asks for a short wait first.
      if (!d) await this.ctx.storage.delete('session');
      await sleep(RECONNECT_MS);
      return this.connect();
    }
    if (op === DISPATCH && t === 'READY') {
      console.log('gateway ready');
      return this.ctx.storage.put('session', { id: d.session_id, url: d.resume_gateway_url, botId: d.user.id, seq: this.seq, intents: INTENTS });
    }
    if (op === DISPATCH && t === 'MESSAGE_CREATE') return this.onMessage(d);
    if (op === DISPATCH && t === 'GUILD_SCHEDULED_EVENT_CREATE') return this.onEvent(d);
    return undefined;
  }

  async login() {
    const session = await this.ctx.storage.get('session');
    const token = this.env.DISCORD_TOKEN;

    // A resumed session keeps the intents it started with, so new intents need a fresh login.
    if (session?.intents === INTENTS) return this.send({ op: RESUME, d: { token, session_id: session.id, seq: this.seq } });
    return this.send({ op: IDENTIFY, d: { token, intents: INTENTS, properties: { os: 'linux', browser: pkg.name, device: pkg.name } } });
  }

  // A new scheduled event goes to the events channel as its link, which Discord shows as a card with an Interested button.
  async onEvent(event) {
    if (!(await this.firstTime(`${EVENT_PREFIX}${event.id}`))) return;
    const by = event.creator_id ? `-# New event by <@${event.creator_id}>\n` : '';
    await botRequest(this.env.DISCORD_TOKEN, 'POST', `/channels/${this.env.EVENTS_CHANNEL}/messages`, {
      content: `${by}https://discord.com/events/${event.guild_id}/${event.id}`,
      allowed_mentions: { parse: [] },
    });
  }

  // A resumed session replays recent events, so each message and event is handled once.
  async firstTime(key) {
    const handled = (await this.ctx.storage.get('handled')) ?? [];
    if (handled.includes(key)) return false;
    await this.ctx.storage.put('handled', [...handled, key].slice(-HANDLED_MAX));
    return true;
  }

  async onMessage(message) {
    const session = await this.ctx.storage.get('session');
    const question = mentionQuestion(message, session?.botId);
    if (question === undefined) return;

    if (!(await this.firstTime(message.id))) return;

    const token = this.env.DISCORD_TOKEN;
    if (!mayAsk(message.member, this.env.ASKER_ROLES.split(','))) {
      await reply(token, message, ONLY_MEMBERS);
      return;
    }
    if (!question) {
      await reply(token, message, HOW_TO_ASK);
      return;
    }
    const placeholder = await reply(token, message, THINKING);
    await this.env.ASKS.get(this.env.ASKS.newUniqueId()).start({ question, target: { channelId: message.channel_id, messageId: placeholder.id } });
  }
}
