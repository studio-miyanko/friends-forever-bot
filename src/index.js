import { DurableObject } from 'cloudflare:workers';

import { answer } from './agent.js';
import { editReply, isFromDiscord } from './discord.js';

const PING = 1;
const COMMAND = 2;
const PONG = 1;
const DEFERRED_REPLY = 5;
const MAX_QUESTION = 300;
const FAILED = 'Something went wrong while looking that up. Try again in a minute.';
const QUOTA_USED = "Today's free AI quota is used up. Try again tomorrow.";

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('wowf-bot', { status: 404 });
    const body = await request.text();
    if (!(await isFromDiscord(request, body, env.DISCORD_PUBLIC_KEY))) return new Response('Bad signature', { status: 401 });

    const interaction = JSON.parse(body);
    if (interaction.type === PING) return Response.json({ type: PONG });
    if (interaction.type !== COMMAND || interaction.data.name !== 'wowf') return new Response('Unknown interaction', { status: 400 });

    const question = String(interaction.data.options?.find((option) => option.name === 'question')?.value ?? '')
      .trim()
      .slice(0, MAX_QUESTION);
    await env.ASKS.get(env.ASKS.idFromName(interaction.id)).start({ question, token: interaction.token });
    return Response.json({ type: DEFERRED_REPLY });
  },
};

// A Worker may only run 30 s after its reply, and free models can take longer, so each question runs in an alarm.
export class Ask extends DurableObject {
  async start(job) {
    await this.ctx.storage.put('job', job);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm() {
    const job = await this.ctx.storage.get('job');
    if (!job) return;

    // Cleared first, because a failed alarm is retried and would ask the model again.
    await this.ctx.storage.deleteAll();
    let reply;
    try {
      reply = await answer(job.question, this.env.OPENROUTER_API_KEY);
    } catch (err) {
      console.log('answer failed', err.message);
      reply = err.message.includes('per-day') ? QUOTA_USED : FAILED;
    }
    await editReply(this.env.DISCORD_APP_ID, job.token, `> ${job.question}\n\n${reply}`);
  }
}
