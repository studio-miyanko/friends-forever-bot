import { Client } from '@modelcontextprotocol/client';

import pkg from '../package.json' with { type: 'json' };

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// The user's preset "free" on OpenRouter tries free models in turn. The key's credit limit of 0 means it can never cost money.
const FALLBACK_MODEL = '@preset/free';
const FALLBACK_TRIES = 3;
const FALLBACK_PAUSE_MS = 1500;

// Each model has its own free daily quota and its own load. The two Flash Lite models answer fastest. Flash is slower,
// but it kept answering on 2026-10-16 while both Lite models refused most calls with 503 "high demand".
export const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash'];
const MAX_STEPS = 6;
const MAX_CALLS = 4;
const RETRY_PAUSE_MS = 5000;

// After this, steps answer at once and skip the retry round, so a reply lands well inside the 15 minutes Discord allows.
const DEADLINE_MS = 5 * 60 * 1000;
const NO_ANSWER = "Sorry, I couldn't find an answer to that.";
const ANSWER_NOW = 'Stop looking things up. Answer the question now from what the tools returned.';
const SKIPPED = 'Skipped: too many lookups at once. Answer from what you have.';
const ARMORY = /^Armory: (https:\/\/worldofwarcraft\.blizzard\.com\/\S+)$/m;
const PORTRAIT = /^Portrait: (https:\/\/render\.worldofwarcraft\.com\/\S+)$/m;

function instructions(today, toolNotes) {
  return `You are Friends Forever Bot. You answer World of Warcraft questions for friends and family in the Discord server Friends Forever, who play WoW Forever. Today is ${today}.

Scope
- Answer only questions about World of Warcraft. For anything else, like the weather, news or homework, reply with one sentence that you only answer World of Warcraft questions, and look nothing up.
- WoW Forever is always meant, even when the user doesn't say so. Never ask which version.

Look things up
- Take every fact from the tool results. Never fill gaps from memory, and leave out what the tools don't show.
- Search with official English names. Turn nicknames, abbreviations and other languages into the in-game name first, like "Rag" into "Ragnaros".
- If search finds nothing, search one distinctive word of the name, or open the page of a related item, quest or NPC and follow its links.
- search covers items, NPCs, quests and spells. For builds, talents and rotations, open the guide hub https://www.wowhead.com/forever/guides with get_page. For news and patch notes, use get_news, then get_page on the newest fitting post.
- For a quest chain, say where its first part starts.
- For a character, use character with region, realm and name, and realm first if the realm is unclear. Blizzard's API has no WoW Forever characters yet, so name the version the tool reports, like Retail or Classic Era.
- Answer once the tools give enough, usually after 2 or 3 lookups.

Reply
- Write in the language of the question. Keep item, quest, NPC and zone names as the tools spell them.
- First line: one sentence that answers the question. If the tools don't have the answer, say so there.
- Then an empty line and the details, at most 5 short bullets. No tables, headings or bold.
- Last line: "Sources:" and at most 3 masked links to pages you opened, like [Ragnaros](https://www.wowhead.com/forever/npc=11502). For a character, link its armory page. Only use URLs from the tool results.
- At most 1,200 characters in total.

Notes from the tools
${toolNotes}`;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Connects to MCP servers through any transport and offers their tools to Gemini, which takes OpenAI-style functions.
// MCP already describes each tool in JSON Schema.
export async function connectTools(transports) {
  const clients = await Promise.all(transports.map(async (transport) => {
    const client = new Client({ name: pkg.name, version: pkg.version });
    await client.connect(transport);
    return client;
  }));
  const entries = (await Promise.all(clients.map(async (client) => (await client.listTools()).tools.map((tool) => ({ client, tool }))))).flat();
  const owners = new Map(entries.map(({ client, tool }) => [tool.name, client]));
  return {
    instructions: clients.map((client) => client.getInstructions()).filter(Boolean).join('\n\n'),
    functions: entries.map(({ tool: { name, description, inputSchema: { $schema, ...parameters } } }) => ({
      type: 'function',
      function: { name, description, parameters },
    })),
    async call({ function: { name, arguments: json } }) {
      try {
        const client = owners.get(name);
        if (!client) throw new Error(`No tool named ${name}`);
        const result = await client.callTool({ name, arguments: JSON.parse(json || '{}') });
        return result.content.map((part) => part.text ?? '').join('\n');
      } catch (err) {
        return `Tool error: ${err.message}`;
      }
    },
    close: () => Promise.all(clients.map((client) => client.close())),
  };
}

// The armory link and portrait come from the armory tool, never from the model, so they can't be made up.
function characterLinks(name, result) {
  const armory = name === 'character' ? result.match(ARMORY)?.[1] : undefined;
  return armory ? { armory, portrait: result.match(PORTRAIT)?.[1] } : undefined;
}

async function askModel(model, messages, tools, apiKey) {
  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, max_tokens: 1500, reasoning_effort: 'low' }),
      signal: AbortSignal.timeout(45_000),
    });
    if (response.ok) {
      const message = (await response.json()).choices?.[0]?.message;
      if (message?.content?.trim() || message?.tool_calls?.length) return { message };
      return { failure: `${model} sent an empty reply` };
    }
    const text = await response.text();
    if (text.includes('PerDay')) return { failure: `${model} used up its daily quota`, quota: true };

    // A wrong key fails on every model, so trying more is pointless.
    return { failure: `${model} answered ${response.status}: ${text.slice(0, 300)}`, fatal: [401, 403].includes(response.status) };
  } catch (err) {
    return { failure: `${model} failed: ${err.message}` };
  }
}

// Busy models usually recover within seconds, so a round where every model failed gets one more try,
// unless every model has used up its daily quota, which lasts until midnight Pacific.
export async function callGemini(messages, tools, apiKey, { retry = true, pause = sleep } = {}) {
  let failure;
  for (let round = 1; round <= (retry ? 2 : 1); round++) {
    if (round > 1) await pause(RETRY_PAUSE_MS);
    let quotas = 0;
    for (const model of MODELS) {
      const result = await askModel(model, messages, tools, apiKey);
      if (result.message) {
        console.log('answered by', model);
        return result.message;
      }
      console.log(result.failure);
      failure = result.failure;
      if (result.fatal) throw new Error(failure);
      if (result.quota) quotas += 1;
    }
    if (quotas === MODELS.length) break;
  }
  throw new Error(failure);
}

// OpenRouter takes only the standard fields of a tool call, while Gemini adds its thought signature to them.
function standardToolCalls(messages) {
  return messages.map((message) => (message.tool_calls
    ? { ...message, tool_calls: message.tool_calls.map(({ id, type, function: { name, arguments: args } }) => ({ id, type, function: { name, arguments: args } })) }
    : message));
}

async function askOpenRouter(messages, tools, apiKey) {
  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'http-referer': `https://github.com/studio-miyanko/${pkg.name}`,
        'x-title': 'Friends Forever Bot',
      },

      // Only providers that support tool calls may take the question.
      body: JSON.stringify({ model: FALLBACK_MODEL, messages: standardToolCalls(messages), tools, max_tokens: 1500, provider: { require_parameters: true } }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.text();
    if (!response.ok) {
      // Free models allow a set number of requests a day, which the user sees like Gemini's used-up quota.
      if (response.status === 429 && /per-day/i.test(body)) return { failure: 'OpenRouter used up its daily quota', final: true };

      // A wrong key or a missing preset fails on every try.
      return { failure: `OpenRouter answered ${response.status}: ${body.slice(0, 300)}`, final: [401, 402, 403, 404].includes(response.status) };
    }
    const data = JSON.parse(body);
    const message = data.choices?.[0]?.message;
    if (message?.content?.trim() || message?.tool_calls?.length) {
      console.log('answered by OpenRouter', data.model);
      return { message };
    }
    return { failure: `OpenRouter's ${data.model} sent an empty reply` };
  } catch (err) {
    return { failure: `OpenRouter failed: ${err.message}` };
  }
}

// The preset's own fallback skips a model only on some errors and never on an empty reply, while a busy free model
// often answers "rate-limited upstream". openrouter/free picks a model at random, so each try likely reaches another.
export async function callOpenRouter(messages, tools, apiKey, { pause = sleep } = {}) {
  let failure;
  for (let attempt = 1; attempt <= FALLBACK_TRIES; attempt++) {
    if (attempt > 1) await pause(FALLBACK_PAUSE_MS);
    const result = await askOpenRouter(messages, tools, apiKey);
    if (result.message) return result.message;
    console.log(result.failure);
    failure = result.failure;
    if (result.final) break;
  }
  throw new Error(failure);
}

// Gemini first. Once it fails, the rest of the question stays on OpenRouter, because Gemini 3 refuses tool calls
// in the history that it didn't sign itself. Without an OpenRouter key, Gemini's error stands.
export function modelChain(fallbackKey) {
  let onFallback = false;
  return async (messages, tools, apiKey, options) => {
    if (!onFallback) {
      try {
        return await callGemini(messages, tools, apiKey, options);
      } catch (err) {
        if (!fallbackKey) throw err;
        console.log('falling back to OpenRouter:', err.message);
        onFallback = true;
      }
    }
    return callOpenRouter(messages, tools, fallbackKey, options);
  };
}

// Asks Gemini with the MCP tools until it answers, and OpenRouter when Gemini can't.
// Returns the text and, after a character lookup, its armory links.
export async function answer(question, { apiKey, fallbackKey, tools, chat = modelChain(fallbackKey), today = new Date().toISOString().slice(0, 10) }) {
  const started = Date.now();

  // Small models follow the language rule more reliably in the message than in the instructions.
  const messages = [
    { role: 'system', content: instructions(today, tools.instructions) },
    { role: 'user', content: `${question}\n\n(Reply in the language of the question above.)` },
  ];
  let character;
  for (let step = 1; ; step++) {
    const late = Date.now() - started > DEADLINE_MS;
    const final = step === MAX_STEPS || late;

    // Gemini ignores tool_choice none and keeps looking things up, so only a plain request makes it answer.
    // Small free models drift into another language, so the last step repeats the question to reply in.
    if (final) messages.push({ role: 'user', content: `${ANSWER_NOW} Reply in the language of this question: ${question}` });
    const reply = await chat(messages, tools.functions, apiKey, { retry: !late });
    if (!reply.tool_calls?.length || final) return { text: reply.content?.trim() || NO_ANSWER, character };

    // Tool calls go back unchanged, because Gemini 3 needs the thought signature inside them.
    messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: reply.tool_calls });
    for (const [index, call] of reply.tool_calls.entries()) {
      const result = index < MAX_CALLS ? await tools.call(call) : SKIPPED;
      character ??= characterLinks(call.function.name, result);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
}
