import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DurableObject } from 'cloudflare:workers';

import { answer, connectTools } from './agent.js';
import { COMMAND } from './command.js';
import { deliver, isFromDiscord, replyMessage } from './discord.js';
import { FEEDS } from './news.js';

export { NewsFeed } from './news.js';

const PING = 1;
const SLASH_COMMAND = 2;
const PONG = 1;
const MESSAGE = 4;
const DEFERRED_REPLY = 5;
const EPHEMERAL = 1 << 6;
const MAX_QUESTION = COMMAND.options[0].max_length;
const MAX_RETRIES = 6;
const FAILED = 'Something went wrong while looking that up. Try again in a minute.';
const QUOTA_USED = "Today's free AI quota is used up. Try again tomorrow.";

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('friends-forever-bot', { status: 404 });
    const body = await request.text();
    if (!(await isFromDiscord(request, body, env.DISCORD_PUBLIC_KEY))) return new Response('Bad signature', { status: 401 });

    const interaction = JSON.parse(body);
    if (interaction.type === PING) return Response.json({ type: PONG });
    if (interaction.type !== SLASH_COMMAND || interaction.data?.name !== COMMAND.name) return new Response('Unknown interaction', { status: 400 });

    // Questions may span lines, while the reply shows them on one.
    const question = String(interaction.data.options?.find((option) => option.name === 'question')?.value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_QUESTION);

    // A blank question would spend the free model quota on nothing.
    if (!question) return Response.json({ type: MESSAGE, data: { content: `Ask a question after /${COMMAND.name}.`, flags: EPHEMERAL } });
    await env.ASKS.get(env.ASKS.newUniqueId()).start({ question, token: interaction.token, appId: interaction.application_id });
    return Response.json({ type: DEFERRED_REPLY });
  },

  // The cron trigger checks every news feed, each in its own object, so one failing feed doesn't hold up the other.
  async scheduled(event, env) {
    const runs = await Promise.allSettled(Object.keys(FEEDS).map((name) => env.NEWS.get(env.NEWS.idFromName(name)).run(name)));
    for (const run of runs) if (run.status === 'rejected') console.log('news failed', run.reason?.message);
  },
};

// The MCP servers run as their own private Workers, which a service binding reaches without a public URL.
// The host in the URL only labels the request.
function mcpServer(binding, path) {
  return new StreamableHTTPClientTransport(new URL(`https://mcp.internal${path}`), { fetch: (url, init) => binding.fetch(url, init) });
}

// A Worker may only run 30 s after its reply, and a question with several lookups can take longer, so each question runs in an alarm.
export class Ask extends DurableObject {
  async start(job) {
    await this.ctx.storage.put('job', job);

    // A second's head start lets Discord store the "thinking…" placeholder before the first edit can arrive.
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async alarm(info) {
    const job = await this.ctx.storage.get('job');
    if (!job) return;

    // The reply is saved before it is sent, so a retry resends it instead of asking the model again,
    // and a retry after a crash sends the failure note instead of silence.
    if (!job.reply) {
      job.reply = info?.isRetry ? replyMessage(job.question, { text: FAILED }) : await this.replyTo(job.question);
      await this.ctx.storage.put('job', job);
    }
    try {
      await deliver(job.appId, job.token, job.reply);
    } catch (err) {

      // A throw makes Cloudflare retry in a fresh invocation with a fresh request budget.
      if ((info?.retryCount ?? 0) < MAX_RETRIES) throw err;
      console.log('reply failed', err.message);
    }
    await this.ctx.storage.deleteAll();
  }

  async replyTo(question) {
    let tools;
    try {
      tools = await connectTools([mcpServer(this.env.WOWHEAD, '/forever/mcp'), mcpServer(this.env.ARMORY, '/mcp')]);
      return replyMessage(question, await answer(question, { apiKey: this.env.GEMINI_API_KEY, fallbackKey: this.env.OPENROUTER_API_KEY, tools }));
    } catch (err) {
      console.log('answer failed', err.message);
      return replyMessage(question, { text: err.message.includes('daily quota') ? QUOTA_USED : FAILED });
    } finally {
      await tools?.close().catch(() => {});
    }
  }
}
